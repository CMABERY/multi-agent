import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { registerAgent } from "../src/agents.js";
import {
  classifyCommandAuthorization,
  classifyToolAuthorization,
  effectiveGrants,
  evaluateAuthorization,
  recordPermissionAudit,
  requiredGrantsFor
} from "../src/permissionPolicy.js";
import { collectPlanIssues, runPlanCheck } from "../src/planCheck.js";
import { runDeployment } from "../src/runner.js";
import type { Agent, Task } from "../src/schemas.js";
import { loadJson, saveJson } from "../src/storage.js";
import { initWorkspace } from "../src/workspace.js";

async function withWorkspace<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "maw-permission-test-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function modelResponse(text: string) {
  return { text, truncated: false };
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    agent_id: "researcher_1",
    role: "Research Agent",
    executor_type: "model_agent",
    model_tier: "mid",
    allowed_tools: ["web_search"],
    command_allowlist: [],
    permissions: {
      external_actions: false,
      destructive_actions: false,
      credential_access: false,
      paid_actions: false,
      public_actions: false,
      policy_grants: []
    },
    max_cost_usd: 1,
    ...overrides
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    task_id: "T-001",
    title: "Research current information",
    owner_agent_id: "researcher_1",
    owner_role: "Research Agent",
    executor: "model_agent",
    model_tier: "mid",
    input_context: ["state/prompt_contract.md"],
    output_required: "Sourced brief",
    acceptance_criteria: ["Brief cites current information"],
    dependencies: [],
    risk_level: "low",
    review_required: false,
    approval_required: false,
    status: "queued",
    artifacts: [],
    deployment_id: "DP-001",
    created_at: "2026-05-08T00:00:00.000Z",
    updated_at: "2026-05-08T00:00:00.000Z",
    ...overrides
  };
}

describe("permissionPolicy unit", () => {
  test("classifyToolAuthorization recognizes web_search and ignores unknown tools", () => {
    const agent = makeAgent();
    const task = makeTask();
    const signals = { dependencyArtifactCount: 0, workspaceContextPathCount: 1 };
    expect(
      classifyToolAuthorization({ toolType: "web_search", agent, task, signals })?.kind
    ).toBe("tool.web_search");
    expect(
      classifyToolAuthorization({ toolType: "shell", agent, task, signals })
    ).toBeUndefined();
  });

  test("requiredGrantsFor demands PublicSearch always and PrivateQueryEgress when context is workspace-derived", () => {
    const agent = makeAgent();
    const task = makeTask();
    const publicOnly = requiredGrantsFor({
      kind: "tool.web_search",
      agent,
      task,
      signals: { dependencyArtifactCount: 0, workspaceContextPathCount: 1 }
    });
    expect(publicOnly).toEqual(["PublicSearch"]);

    const privateEgressByDependency = requiredGrantsFor({
      kind: "tool.web_search",
      agent,
      task,
      signals: { dependencyArtifactCount: 1, workspaceContextPathCount: 1 }
    });
    expect(privateEgressByDependency).toEqual(["PublicSearch", "PrivateQueryEgress"]);

    const privateEgressByContext = requiredGrantsFor({
      kind: "tool.web_search",
      agent,
      task,
      signals: { dependencyArtifactCount: 0, workspaceContextPathCount: 5 }
    });
    expect(privateEgressByContext).toEqual(["PublicSearch", "PrivateQueryEgress"]);
  });

  test("effectiveGrants maps legacy external_actions=true to implicit PublicSearch", () => {
    const legacy = makeAgent({
      permissions: {
        external_actions: true,
        destructive_actions: false,
        credential_access: false,
        paid_actions: false,
        public_actions: false,
        policy_grants: []
      }
    });
    expect(effectiveGrants(legacy)).toContain("PublicSearch");

    const explicit = makeAgent({
      permissions: {
        external_actions: false,
        destructive_actions: false,
        credential_access: false,
        paid_actions: false,
        public_actions: false,
        policy_grants: ["PublicSearch", "PrivateQueryEgress"]
      }
    });
    expect(effectiveGrants(explicit)).toEqual(
      expect.arrayContaining(["PublicSearch", "PrivateQueryEgress"])
    );
  });

  test("evaluateAuthorization is default-deny when grants are missing", () => {
    const agent = makeAgent();
    const task = makeTask();
    const decision = evaluateAuthorization({
      kind: "tool.web_search",
      agent,
      task,
      signals: { dependencyArtifactCount: 0, workspaceContextPathCount: 1 }
    });
    expect(decision.decision).toBe("deny");
    expect(decision.missing_grants).toContain("PublicSearch");
  });

  test("evaluateAuthorization allows when all required grants are present", () => {
    const agent = makeAgent({
      permissions: {
        external_actions: false,
        destructive_actions: false,
        credential_access: false,
        paid_actions: false,
        public_actions: false,
        policy_grants: ["PublicSearch", "PrivateQueryEgress"]
      }
    });
    const task = makeTask();
    const decision = evaluateAuthorization({
      kind: "tool.web_search",
      agent,
      task,
      signals: { dependencyArtifactCount: 2, workspaceContextPathCount: 3 }
    });
    expect(decision.decision).toBe("allow");
    expect(decision.missing_grants).toEqual([]);
    expect(decision.required_grants).toEqual(["PublicSearch", "PrivateQueryEgress"]);
  });

  test("classifyCommandAuthorization returns command.execute with command signals", () => {
    const agent = makeAgent({
      executor_type: "local_command",
      command_allowlist: ["node"]
    });
    const task = makeTask({
      executor: "local_command",
      command: { command: "node", args: ["-e", "console.log('ok')"] }
    });
    const request = classifyCommandAuthorization({
      commandSpec: task.command!,
      agent,
      task
    });
    expect(request.kind).toBe("command.execute");
    expect(request.signals).toEqual({ commandName: "node", argCount: 2 });
  });

  test("requiredGrantsFor command.execute demands LocalCommandExecute", () => {
    const agent = makeAgent({ executor_type: "local_command" });
    const task = makeTask({
      executor: "local_command",
      command: { command: "node", args: [] }
    });
    const required = requiredGrantsFor({
      kind: "command.execute",
      agent,
      task,
      signals: { commandName: "node", argCount: 0 }
    });
    expect(required).toEqual(["LocalCommandExecute"]);
  });

  test("evaluateAuthorization for command.execute denies without LocalCommandExecute and allows with it", () => {
    const command = { command: "node", args: [] };
    const baseAgent = makeAgent({ executor_type: "local_command", command_allowlist: ["node"] });
    const task = makeTask({ executor: "local_command", command });

    const denied = evaluateAuthorization(
      classifyCommandAuthorization({ commandSpec: command, agent: baseAgent, task })
    );
    expect(denied.decision).toBe("deny");
    expect(denied.missing_grants).toEqual(["LocalCommandExecute"]);

    const granted = makeAgent({
      executor_type: "local_command",
      command_allowlist: ["node"],
      permissions: {
        external_actions: false,
        destructive_actions: false,
        credential_access: false,
        paid_actions: false,
        public_actions: false,
        policy_grants: ["LocalCommandExecute"]
      }
    });
    const allowed = evaluateAuthorization(
      classifyCommandAuthorization({ commandSpec: command, agent: granted, task })
    );
    expect(allowed.decision).toBe("allow");
    expect(allowed.missing_grants).toEqual([]);
  });

  test("evaluateAuthorization denies PrivateQueryEgress even when PublicSearch is granted", () => {
    const agent = makeAgent({
      permissions: {
        external_actions: false,
        destructive_actions: false,
        credential_access: false,
        paid_actions: false,
        public_actions: false,
        policy_grants: ["PublicSearch"]
      }
    });
    const task = makeTask({ dependencies: ["T-000"] });
    const decision = evaluateAuthorization({
      kind: "tool.web_search",
      agent,
      task,
      signals: { dependencyArtifactCount: 1, workspaceContextPathCount: 1 }
    });
    expect(decision.decision).toBe("deny");
    expect(decision.missing_grants).toEqual(["PrivateQueryEgress"]);
  });
});

describe("recordPermissionAudit", () => {
  test("appends events with monotonic ids", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const agent = makeAgent();
      const task = makeTask();
      const request = classifyToolAuthorization({
        toolType: "web_search",
        agent,
        task,
        signals: { dependencyArtifactCount: 0, workspaceContextPathCount: 1 }
      })!;
      const decision = evaluateAuthorization(request);
      const first = await recordPermissionAudit(root, {
        deploymentId: "DP-001",
        request,
        decision
      });
      const second = await recordPermissionAudit(root, {
        deploymentId: "DP-001",
        request,
        decision
      });
      expect(first.event_id).toBe("PA-001");
      expect(second.event_id).toBe("PA-002");

      const store = await loadJson(root, "state/permission_audit.json");
      expect(store.events).toHaveLength(2);
      expect(store.events[0]).toMatchObject({
        deployment_id: "DP-001",
        task_id: "T-001",
        agent_id: "researcher_1",
        action_kind: "tool.web_search",
        decision: "deny",
        missing_grants: ["PublicSearch"]
      });
    });
  });
});

describe("plan-check policy gating", () => {
  function planFor(task: Task, agentId: string) {
    return {
      deployment_id: "DP-001",
      intent_id: "I-001",
      status: "proposed" as const,
      approval_required: false,
      assignments: [
        {
          task_id: task.task_id,
          agent_id: agentId,
          executor: "model_agent" as const,
          model_tier: task.model_tier,
          reason: "Authorize hosted web search.",
          approval_required: false
        }
      ],
      created_at: "2026-05-08T00:00:00.000Z",
      updated_at: "2026-05-08T00:00:00.000Z"
    };
  }

  test("emits WEB_SEARCH_PUBLIC_SEARCH_MISSING when allowed_tools includes web_search but no grant", () => {
    const agent = makeAgent();
    const task = makeTask();
    const issues = collectPlanIssues({
      plan: planFor(task, agent.agent_id),
      tasks: [task],
      registry: { agents: [agent] },
      artifactIndex: { artifacts: [] }
    });
    const codes = issues.map((issue) => issue.code);
    expect(codes).toContain("WEB_SEARCH_PUBLIC_SEARCH_MISSING");
    const issue = issues.find((entry) => entry.code === "WEB_SEARCH_PUBLIC_SEARCH_MISSING");
    expect(issue?.severity).toBe("high");
    expect(issue?.target).toBe(task.task_id + "/" + agent.agent_id);
  });

  test("emits WEB_SEARCH_PRIVATE_EGRESS_MISSING when task has dependencies and only PublicSearch is granted", () => {
    const agent = makeAgent({
      permissions: {
        external_actions: false,
        destructive_actions: false,
        credential_access: false,
        paid_actions: false,
        public_actions: false,
        policy_grants: ["PublicSearch"]
      }
    });
    const dep = makeTask({ task_id: "T-000", dependencies: [] });
    const task = makeTask({ dependencies: ["T-000"] });
    const issues = collectPlanIssues({
      plan: planFor(task, agent.agent_id),
      tasks: [dep, task],
      registry: { agents: [agent] },
      artifactIndex: { artifacts: [] }
    });
    const codes = issues.map((issue) => issue.code);
    expect(codes).toContain("WEB_SEARCH_PRIVATE_EGRESS_MISSING");
    expect(codes).not.toContain("WEB_SEARCH_PUBLIC_SEARCH_MISSING");
  });

  test("does not emit policy issues when grants are sufficient", () => {
    const agent = makeAgent({
      permissions: {
        external_actions: false,
        destructive_actions: false,
        credential_access: false,
        paid_actions: false,
        public_actions: false,
        policy_grants: ["PublicSearch", "PrivateQueryEgress"]
      }
    });
    const dep = makeTask({ task_id: "T-000", dependencies: [] });
    const task = makeTask({ dependencies: ["T-000"] });
    const issues = collectPlanIssues({
      plan: planFor(task, agent.agent_id),
      tasks: [dep, task],
      registry: { agents: [agent] },
      artifactIndex: { artifacts: [] }
    });
    expect(issues.map((entry) => entry.code)).not.toContain("WEB_SEARCH_PUBLIC_SEARCH_MISSING");
    expect(issues.map((entry) => entry.code)).not.toContain("WEB_SEARCH_PRIVATE_EGRESS_MISSING");
  });

  test("does not flag agents that do not request web_search", () => {
    const agent = makeAgent({ allowed_tools: [] });
    const task = makeTask();
    const issues = collectPlanIssues({
      plan: planFor(task, agent.agent_id),
      tasks: [task],
      registry: { agents: [agent] },
      artifactIndex: { artifacts: [] }
    });
    expect(issues.map((entry) => entry.code)).not.toContain("WEB_SEARCH_PUBLIC_SEARCH_MISSING");
    expect(issues.map((entry) => entry.code)).not.toContain("WEB_SEARCH_PRIVATE_EGRESS_MISSING");
  });

  test("emits LOCAL_COMMAND_EXECUTE_GRANT_MISSING when local_command agent lacks the grant", () => {
    const agent = makeAgent({
      agent_id: "shell_1",
      role: "Local Shell Agent",
      executor_type: "local_command",
      allowed_tools: ["shell"],
      command_allowlist: ["node"]
    });
    const task = makeTask({
      task_id: "T-002",
      executor: "local_command",
      command: { command: "node", args: ["-e", "1"] }
    });
    const plan = {
      deployment_id: "DP-001",
      intent_id: "I-001",
      status: "proposed" as const,
      approval_required: false,
      assignments: [
        {
          task_id: task.task_id,
          agent_id: agent.agent_id,
          executor: "local_command" as const,
          model_tier: task.model_tier,
          reason: "Run node script.",
          approval_required: false
        }
      ],
      created_at: "2026-05-08T00:00:00.000Z",
      updated_at: "2026-05-08T00:00:00.000Z"
    };
    const issues = collectPlanIssues({
      plan,
      tasks: [task],
      registry: { agents: [agent] },
      artifactIndex: { artifacts: [] }
    });
    const issue = issues.find((entry) => entry.code === "LOCAL_COMMAND_EXECUTE_GRANT_MISSING");
    expect(issue).toBeTruthy();
    expect(issue?.severity).toBe("high");
    expect(issue?.target).toBe(task.task_id + "/" + agent.agent_id);
  });

  test("does not flag local_command when LocalCommandExecute is granted", () => {
    const agent = makeAgent({
      agent_id: "shell_1",
      role: "Local Shell Agent",
      executor_type: "local_command",
      allowed_tools: ["shell"],
      command_allowlist: ["node"],
      permissions: {
        external_actions: false,
        destructive_actions: false,
        credential_access: false,
        paid_actions: false,
        public_actions: false,
        policy_grants: ["LocalCommandExecute"]
      }
    });
    const task = makeTask({
      task_id: "T-002",
      executor: "local_command",
      command: { command: "node", args: [] }
    });
    const plan = {
      deployment_id: "DP-001",
      intent_id: "I-001",
      status: "proposed" as const,
      approval_required: false,
      assignments: [
        {
          task_id: task.task_id,
          agent_id: agent.agent_id,
          executor: "local_command" as const,
          model_tier: task.model_tier,
          reason: "Run node script.",
          approval_required: false
        }
      ],
      created_at: "2026-05-08T00:00:00.000Z",
      updated_at: "2026-05-08T00:00:00.000Z"
    };
    const issues = collectPlanIssues({
      plan,
      tasks: [task],
      registry: { agents: [agent] },
      artifactIndex: { artifacts: [] }
    });
    expect(issues.map((entry) => entry.code)).not.toContain(
      "LOCAL_COMMAND_EXECUTE_GRANT_MISSING"
    );
  });

  test("does not flag model_agent assignments with the LOCAL_COMMAND code", () => {
    const agent = makeAgent({
      permissions: {
        external_actions: false,
        destructive_actions: false,
        credential_access: false,
        paid_actions: false,
        public_actions: false,
        policy_grants: ["PublicSearch"]
      }
    });
    const task = makeTask();
    const issues = collectPlanIssues({
      plan: planFor(task, agent.agent_id),
      tasks: [task],
      registry: { agents: [agent] },
      artifactIndex: { artifacts: [] }
    });
    expect(issues.map((entry) => entry.code)).not.toContain(
      "LOCAL_COMMAND_EXECUTE_GRANT_MISSING"
    );
  });

  test("runPlanCheck fails the deployment when policy issues are present", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await registerAgent(root, makeAgent());
      await saveJson(root, "state/task_board.json", { tasks: [makeTask()] });
      await saveJson(root, "state/deployment_plan.json", {
        deployment_plans: [
          {
            deployment_id: "DP-001",
            intent_id: "I-001",
            status: "proposed",
            approval_required: false,
            assignments: [
              {
                task_id: "T-001",
                agent_id: "researcher_1",
                executor: "model_agent",
                model_tier: "mid",
                reason: "Authorize hosted web search.",
                approval_required: false
              }
            ],
            created_at: "2026-05-08T00:00:00.000Z",
            updated_at: "2026-05-08T00:00:00.000Z"
          }
        ]
      });
      const check = await runPlanCheck(root, { deploymentId: "DP-001" });
      expect(check.status).toBe("fail");
      expect(check.issues.map((issue) => issue.code)).toContain(
        "WEB_SEARCH_PUBLIC_SEARCH_MISSING"
      );
    });
  });
});

describe("runner web-search policy enforcement", () => {
  async function setupDeployment(
    root: string,
    options: { allowedGrants: Array<"PublicSearch" | "PrivateQueryEgress">; dependencies: string[] }
  ): Promise<void> {
    await initWorkspace(root);
    await registerAgent(root, {
      agent_id: "researcher_1",
      role: "Research Agent",
      executor_type: "model_agent",
      model_tier: "mid",
      allowed_tools: ["web_search"],
      command_allowlist: [],
      permissions: {
        external_actions: false,
        destructive_actions: false,
        credential_access: false,
        paid_actions: false,
        public_actions: false,
        policy_grants: options.allowedGrants
      },
      max_cost_usd: 1
    });
    await saveJson(root, "state/task_board.json", {
      tasks: [
        makeTask({
          task_id: "T-001",
          dependencies: options.dependencies,
          input_context: ["state/prompt_contract.md"]
        })
      ]
    });
    await saveJson(root, "state/deployment_plan.json", {
      deployment_plans: [
        {
          deployment_id: "DP-001",
          intent_id: "I-001",
          status: "approved",
          approval_required: false,
          assignments: [
            {
              task_id: "T-001",
              agent_id: "researcher_1",
              executor: "model_agent",
              model_tier: "mid",
              reason: "Authorize web search.",
              approval_required: false
            }
          ],
          created_at: "2026-05-08T00:00:00.000Z",
          updated_at: "2026-05-08T00:00:00.000Z"
        }
      ]
    });
  }

  test("denies hosted web_search when agent lacks PublicSearch and audits the decision", async () => {
    await withWorkspace(async (root) => {
      await setupDeployment(root, { allowedGrants: [], dependencies: [] });
      // Bypass plan-check by writing a passing record directly so runtime denial path is exercised.
      await saveJson(root, "state/plan_checks.json", {
        plan_checks: [
          {
            check_id: "PC-001",
            deployment_id: "DP-001",
            status: "pass",
            issues: [],
            created_at: "2026-05-08T00:00:00.000Z",
            updated_at: "2099-01-01T00:00:00.000Z"
          }
        ]
      });
      const modelClient = {
        createResponse: vi.fn().mockResolvedValue(modelResponse("brief"))
      };
      await runDeployment(root, { deploymentId: "DP-001", modelClient });

      const request = modelClient.createResponse.mock.calls[0]?.[0];
      expect(request.tools).toBeUndefined();
      expect(request.toolChoice).toBeUndefined();
      expect(request.include).toBeUndefined();

      const audit = await loadJson(root, "state/permission_audit.json");
      expect(audit.events).toHaveLength(1);
      expect(audit.events[0]).toMatchObject({
        decision: "deny",
        missing_grants: ["PublicSearch"],
        agent_id: "researcher_1",
        deployment_id: "DP-001"
      });

      const chat = await loadJson(root, "state/chat.json");
      const denialMessage = chat.messages.find(
        (entry: { summary: string }) => entry.summary.includes("Hosted web_search denied")
      );
      expect(denialMessage).toBeTruthy();
      expect(denialMessage.summary).toContain("PublicSearch");
    });
  });

  test("allows web_search when PublicSearch is granted and there is no private context", async () => {
    await withWorkspace(async (root) => {
      await setupDeployment(root, { allowedGrants: ["PublicSearch"], dependencies: [] });
      const modelClient = {
        createResponse: vi.fn().mockResolvedValue(modelResponse("brief"))
      };
      await runPlanCheck(root, { deploymentId: "DP-001" });
      await runDeployment(root, { deploymentId: "DP-001", modelClient });

      const request = modelClient.createResponse.mock.calls[0]?.[0];
      expect(request.tools).toEqual([{ type: "web_search" }]);
      expect(request.toolChoice).toBe("auto");

      const audit = await loadJson(root, "state/permission_audit.json");
      expect(audit.events[0]).toMatchObject({
        decision: "allow",
        required_grants: ["PublicSearch"],
        missing_grants: []
      });
    });
  });

  test("denies web_search when private context is in scope and PrivateQueryEgress is not granted", async () => {
    await withWorkspace(async (root) => {
      await setupDeployment(root, { allowedGrants: ["PublicSearch"], dependencies: ["T-000"] });
      // Add a prior task and artifact so dependency artifact count > 0.
      const board = await loadJson(root, "state/task_board.json");
      board.tasks.unshift(
        makeTask({
          task_id: "T-000",
          dependencies: [],
          status: "completed",
          artifacts: ["ART-000"]
        })
      );
      await saveJson(root, "state/task_board.json", board);
      await saveJson(root, "artifacts/artifact_index.json", {
        artifacts: [
          {
            artifact_id: "ART-000",
            task_id: "T-000",
            path: "state/prompt_contract.md",
            type: "model_output",
            description: "Prior workspace-derived artifact",
            created_at: "2026-05-08T00:00:00.000Z"
          }
        ]
      });
      // Plan-check would reject this, by design — bypass it here to exercise runtime enforcement.
      await saveJson(root, "state/plan_checks.json", {
        plan_checks: [
          {
            check_id: "PC-001",
            deployment_id: "DP-001",
            status: "pass",
            issues: [],
            created_at: "2026-05-08T00:00:00.000Z",
            updated_at: "2099-01-01T00:00:00.000Z"
          }
        ]
      });

      const modelClient = {
        createResponse: vi.fn().mockResolvedValue(modelResponse("brief"))
      };
      await runDeployment(root, { deploymentId: "DP-001", modelClient });

      const request = modelClient.createResponse.mock.calls[0]?.[0];
      expect(request.tools).toBeUndefined();
      const audit = await loadJson(root, "state/permission_audit.json");
      expect(audit.events[0]).toMatchObject({
        decision: "deny",
        required_grants: ["PublicSearch", "PrivateQueryEgress"],
        missing_grants: ["PrivateQueryEgress"]
      });
    });
  });

  test("allows web_search with private context when both grants are present", async () => {
    await withWorkspace(async (root) => {
      await setupDeployment(root, {
        allowedGrants: ["PublicSearch", "PrivateQueryEgress"],
        dependencies: ["T-000"]
      });
      const board = await loadJson(root, "state/task_board.json");
      board.tasks.unshift(
        makeTask({
          task_id: "T-000",
          dependencies: [],
          status: "completed",
          artifacts: ["ART-000"]
        })
      );
      await saveJson(root, "state/task_board.json", board);
      await saveJson(root, "artifacts/artifact_index.json", {
        artifacts: [
          {
            artifact_id: "ART-000",
            task_id: "T-000",
            path: "state/prompt_contract.md",
            type: "model_output",
            description: "Prior workspace-derived artifact",
            created_at: "2026-05-08T00:00:00.000Z"
          }
        ]
      });

      const modelClient = {
        createResponse: vi.fn().mockResolvedValue(modelResponse("brief"))
      };
      await runPlanCheck(root, { deploymentId: "DP-001" });
      await runDeployment(root, { deploymentId: "DP-001", modelClient });

      const request = modelClient.createResponse.mock.calls[0]?.[0];
      expect(request.tools).toEqual([{ type: "web_search" }]);
      const audit = await loadJson(root, "state/permission_audit.json");
      expect(audit.events[0]).toMatchObject({
        decision: "allow",
        required_grants: ["PublicSearch", "PrivateQueryEgress"],
        missing_grants: []
      });
    });
  });
});

describe("runner local_command policy enforcement", () => {
  async function setupCommandDeployment(
    root: string,
    options: { policyGrants: Array<"LocalCommandExecute"> }
  ): Promise<void> {
    await initWorkspace(root);
    await registerAgent(root, {
      agent_id: "shell_1",
      role: "Local Shell Agent",
      executor_type: "local_command",
      allowed_tools: ["shell"],
      command_allowlist: ["node"],
      permissions: {
        external_actions: false,
        destructive_actions: false,
        credential_access: false,
        paid_actions: false,
        public_actions: false,
        policy_grants: options.policyGrants
      }
    });
    await saveJson(root, "state/task_board.json", {
      tasks: [
        {
          task_id: "T-001",
          title: "Run allowed command",
          owner_agent_id: "shell_1",
          owner_role: "Local Shell Agent",
          executor: "local_command",
          model_tier: "low",
          input_context: [],
          output_required: "Command output",
          acceptance_criteria: ["Command exits successfully"],
          dependencies: [],
          risk_level: "low",
          review_required: false,
          approval_required: false,
          status: "queued",
          artifacts: [],
          command: { command: "node", args: ["-e", "console.log('ok')"] },
          deployment_id: "DP-001",
          created_at: "2026-05-08T00:00:00.000Z",
          updated_at: "2026-05-08T00:00:00.000Z"
        }
      ]
    });
    await saveJson(root, "state/deployment_plan.json", {
      deployment_plans: [
        {
          deployment_id: "DP-001",
          intent_id: "I-001",
          status: "approved",
          approval_required: false,
          assignments: [
            {
              task_id: "T-001",
              agent_id: "shell_1",
              executor: "local_command",
              model_tier: "low",
              reason: "Run allowed command.",
              approval_required: false
            }
          ],
          created_at: "2026-05-08T00:00:00.000Z",
          updated_at: "2026-05-08T00:00:00.000Z"
        }
      ]
    });
    // Bypass plan-check to exercise the runtime denial path; with a missing grant
    // plan-check would otherwise reject the deployment.
    await saveJson(root, "state/plan_checks.json", {
      plan_checks: [
        {
          check_id: "PC-001",
          deployment_id: "DP-001",
          status: "pass",
          issues: [],
          created_at: "2026-05-08T00:00:00.000Z",
          updated_at: "2099-01-01T00:00:00.000Z"
        }
      ]
    });
  }

  test("denies and fails the task when LocalCommandExecute grant is missing", async () => {
    await withWorkspace(async (root) => {
      await setupCommandDeployment(root, { policyGrants: [] });
      const result = await runDeployment(root, { deploymentId: "DP-001", execute: true });
      expect(result.completed).toEqual([]);
      expect(result.failed).toEqual(["T-001"]);

      const board = await loadJson(root, "state/task_board.json");
      const task = board.tasks.find((entry: { task_id: string }) => entry.task_id === "T-001");
      expect(task.status).toBe("failed");
      expect(task.blocker).toContain("LocalCommandExecute");

      const audit = await loadJson(root, "state/permission_audit.json");
      expect(audit.events).toHaveLength(1);
      expect(audit.events[0]).toMatchObject({
        decision: "deny",
        action_kind: "command.execute",
        agent_id: "shell_1",
        deployment_id: "DP-001",
        missing_grants: ["LocalCommandExecute"]
      });
      expect(audit.events[0].action_signals).toMatchObject({
        command_name: "node",
        arg_count: 2
      });

      const chat = await loadJson(root, "state/chat.json");
      const blocker = chat.messages.find(
        (entry: { type: string; task_id?: string }) =>
          entry.type === "blocker" && entry.task_id === "T-001"
      );
      expect(blocker).toBeTruthy();
      expect(blocker.summary).toContain("LocalCommandExecute");

      await expect(
        loadJson(root, "artifacts/runs/T-001/command_result.json")
      ).rejects.toThrow();
    });
  });

  test("allows and runs the command when LocalCommandExecute is granted", async () => {
    await withWorkspace(async (root) => {
      await setupCommandDeployment(root, { policyGrants: ["LocalCommandExecute"] });
      const result = await runDeployment(root, { deploymentId: "DP-001", execute: true });
      expect(result.completed).toEqual(["T-001"]);
      expect(result.failed).toEqual([]);

      const audit = await loadJson(root, "state/permission_audit.json");
      expect(audit.events[0]).toMatchObject({
        decision: "allow",
        action_kind: "command.execute",
        required_grants: ["LocalCommandExecute"],
        missing_grants: []
      });

      const commandResult = await loadJson(root, "artifacts/runs/T-001/command_result.json");
      expect(commandResult.exit_code).toBe(0);
    });
  });
});
