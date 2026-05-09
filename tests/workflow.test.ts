import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { recordApproval } from "../src/approvals.js";
import { registerAgent } from "../src/agents.js";
import { addArtifact } from "../src/artifacts.js";
import { createIntent, orchestrateIntent } from "../src/orchestrator.js";
import { collectPlanIssues } from "../src/planCheck.js";
import { generateReport } from "../src/report.js";
import { recordReview } from "../src/reviews.js";
import { runDeployment } from "../src/runner.js";
import { writeWorkflowScore } from "../src/scoring.js";
import { loadJson, saveJson, saveText } from "../src/storage.js";
import { validateWorkspace } from "../src/validator.js";
import { initWorkspace } from "../src/workspace.js";

async function withWorkspace<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "maw-test-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function validOrchestratorPayload() {
  return {
    prompt_contract_markdown:
      "# Prompt Contract\n\nGoal: Build a working demo.\n\nAcceptance Criteria:\n- Produce a verified output.\n",
    tasks: [
      {
        title: "Draft implementation artifact",
        owner_agent_id: "researcher_1",
        owner_role: "Research Agent",
        executor: "model_agent",
        model_tier: "mid",
        input_context: ["state/prompt_contract.md"],
        output_required: "Implementation draft",
        acceptance_criteria: ["Draft addresses the prompt contract"],
        dependencies: [],
        risk_level: "medium",
        review_required: false,
        approval_required: false
      }
    ],
    deployment_plan: {
      approval_required: true,
      assignments: [
        {
          task_id: "T-001",
          agent_id: "researcher_1",
          executor: "model_agent",
          model_tier: "mid",
          reason: "Researcher produces the first artifact from the contract.",
          approval_required: false
        }
      ]
    },
    decisions: [
      {
        decision: "Use local registered agents for MVP deployment.",
        rationale: "This keeps the run auditable and local.",
        owner: "orchestrator"
      }
    ]
  };
}

function dryRunPacketPayload() {
  return {
    ...validOrchestratorPayload(),
    tasks: [
      {
        ...validOrchestratorPayload().tasks[0],
        owner_agent_id: "builder_1",
        owner_role: "Builder Agent",
        executor: "dry_run",
        output_required: "Delegation packet",
        acceptance_criteria: ["Delegation packet exists"]
      }
    ],
    deployment_plan: {
      approval_required: true,
      assignments: [
        {
          task_id: "T-001",
          agent_id: "builder_1",
          executor: "dry_run",
          model_tier: "mid",
          reason: "Emit only a delegation packet.",
          approval_required: false
        }
      ]
    }
  };
}

function brokenDryRunDeliverablePayload() {
  return {
    ...validOrchestratorPayload(),
    tasks: [
      {
        ...validOrchestratorPayload().tasks[0],
        owner_agent_id: "builder_1",
        owner_role: "Builder Agent",
        executor: "dry_run",
        output_required: "Implementation draft",
        review_required: false
      }
    ],
    deployment_plan: {
      approval_required: true,
      assignments: [
        {
          task_id: "T-001",
          agent_id: "builder_1",
          executor: "dry_run",
          model_tier: "mid",
          reason: "Incorrectly route deliverable to dry run.",
          approval_required: false
        }
      ]
    }
  };
}

function highRiskPayloadFor(agentId: string, role = "Research Agent") {
  return {
    ...validOrchestratorPayload(),
    tasks: [
      {
        ...validOrchestratorPayload().tasks[0],
        title: "Produce high-risk verified artifact",
        owner_agent_id: agentId,
        owner_role: role,
        executor: "model_agent",
        model_tier: "high",
        output_required: "High-risk implementation draft",
        acceptance_criteria: ["High-risk draft addresses the prompt contract"],
        risk_level: "high",
        review_required: true
      }
    ],
    deployment_plan: {
      approval_required: true,
      assignments: [
        {
          task_id: "T-001",
          agent_id: agentId,
          executor: "model_agent",
          model_tier: "high",
          reason: "Route high-risk work to a model agent.",
          approval_required: false
        }
      ]
    }
  };
}

function synthesisPayloadWithNewDependency() {
  return {
    ...validOrchestratorPayload(),
    tasks: [
      {
        ...validOrchestratorPayload().tasks[0],
        title: "Produce source brief",
        owner_agent_id: "researcher_1",
        owner_role: "Research Agent",
        executor: "model_agent",
        model_tier: "mid",
        output_required: "Source brief",
        acceptance_criteria: ["Source brief addresses the prompt contract"],
        dependencies: [],
        review_required: false
      },
      {
        ...validOrchestratorPayload().tasks[0],
        title: "Synthesize source brief",
        owner_agent_id: "reviewer_skeptical",
        owner_role: "Reviewer Agent",
        executor: "model_agent",
        model_tier: "high",
        output_required: "Synthesis report",
        acceptance_criteria: ["Synthesis report cites the source brief"],
        dependencies: ["T-001"],
        review_required: false
      }
    ],
    deployment_plan: {
      approval_required: true,
      assignments: [
        {
          task_id: "T-001",
          agent_id: "researcher_1",
          executor: "model_agent",
          model_tier: "mid",
          reason: "Researcher produces the source artifact.",
          approval_required: false
        },
        {
          task_id: "T-002",
          agent_id: "reviewer_skeptical",
          executor: "model_agent",
          model_tier: "high",
          reason: "Reviewer synthesizes the newly produced source artifact.",
          approval_required: false
        }
      ]
    }
  };
}

function modelResponse(
  text: string,
  overrides: Partial<{
    truncated: boolean;
    status: string;
    reason: string;
    usage: { input_tokens: number; output_tokens: number };
  }> = {}
) {
  return {
    text,
    truncated: false,
    ...overrides
  };
}

function workflowTask(overrides: Record<string, unknown> = {}) {
  return {
    task_id: "T-001",
    title: "Produce model output",
    owner_agent_id: "reviewer_skeptical",
    owner_role: "Reviewer Agent",
    executor: "model_agent",
    model_tier: "high",
    input_context: ["state/prompt_contract.md"],
    output_required: "Review output",
    acceptance_criteria: ["Output exists"],
    dependencies: [],
    risk_level: "medium",
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

function workflowAssignment(overrides: Record<string, unknown> = {}) {
  return {
    task_id: "T-001",
    agent_id: "reviewer_skeptical",
    executor: "model_agent",
    model_tier: "high",
    reason: "Exercise workflow behavior.",
    approval_required: false,
    ...overrides
  };
}

async function seedApprovedDeployment(
  root: string,
  tasks: Array<Record<string, unknown>>,
  assignments: Array<Record<string, unknown>>
): Promise<void> {
  await saveJson(root, "state/task_board.json", { tasks });
  await saveJson(root, "state/deployment_plan.json", {
    deployment_plans: [
      {
        deployment_id: "DP-001",
        intent_id: "I-001",
        status: "approved",
        approval_required: false,
        assignments,
        created_at: "2026-05-08T00:00:00.000Z",
        updated_at: "2026-05-08T00:00:00.000Z"
      }
    ]
  });
}

describe("agentic orchestrator workflow", () => {
  test("init creates the workflow state, protocol templates, and default registry", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);

      const registry = await loadJson(root, "state/agent_registry.json");
      const protocol = await readFile(join(root, "protocols/debate_protocol.md"), "utf8");
      const instructions = await readFile(join(root, "instructions/orchestrator.md"), "utf8");

      expect(registry.agents.map((agent: { agent_id: string }) => agent.agent_id)).toContain(
        "orchestrator_1"
      );
      expect(protocol).toContain("fixed number of rounds");
      expect(instructions).toContain("Prompt Contract");
    });
  });

  test("orchestrator turns an intent into a contract, tasks, deployment plan, and decision record", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const intent = await createIntent(root, { text: "Build a verified demo artifact." });
      const modelClient = {
        createResponse: vi.fn().mockResolvedValue(modelResponse(JSON.stringify(validOrchestratorPayload())))
      };

      const result = await orchestrateIntent(root, {
        intentId: intent.intent_id,
        modelClient
      });

      const contract = await readFile(join(root, "state/prompt_contract.md"), "utf8");
      const tasks = await loadJson(root, "state/task_board.json");
      const plans = await loadJson(root, "state/deployment_plan.json");
      const decisions = await readFile(join(root, "state/decision_log.md"), "utf8");

      expect(result.deployment_id).toBe("DP-001");
      expect(contract).toContain("Build a working demo");
      expect(tasks.tasks).toHaveLength(1);
      expect(tasks.tasks[0].task_id).toBe("T-001");
      expect(plans.deployment_plans[0].status).toBe("proposed");
      expect(decisions).toContain("Use local registered agents");
      const firstCall = modelClient.createResponse.mock.calls[0]?.[0];
      expect(firstCall).toEqual(
        expect.objectContaining({
          instructions: expect.stringContaining("You are the orchestrator agent"),
          input: expect.stringContaining("Build a verified demo artifact")
        })
      );
      expect(firstCall?.instructions).not.toContain("Active learning rules from prior runs");
    });
  });

  test("createIntent rejects invalid risk level before writing the intent queue", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const before = await loadJson(root, "state/intent_queue.json");

      await expect(
        createIntent(root, { text: "Test", riskLevel: "bogus" })
      ).rejects.toThrow(/^Invalid risk level: bogus\. Must be low, medium, or high\.$/);

      const after = await loadJson(root, "state/intent_queue.json");
      expect(after).toEqual(before);
    });
  });

  test("createIntent rejects empty text before writing the intent queue", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const before = await loadJson(root, "state/intent_queue.json");

      await expect(createIntent(root, { text: "   " })).rejects.toThrow(
        /^Intent text must be non-empty\.$/
      );

      const after = await loadJson(root, "state/intent_queue.json");
      expect(after).toEqual(before);
    });
  });

  test("model HALT signal blocks the task without spawning reviewers", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const intent = await createIntent(root, { text: "Build something." });
      const haltText =
        "HALT: Source data is contradictory; refusing to fabricate convergence.\n\nFurther reasoning explaining the contradiction.";
      const modelClient = {
        createResponse: vi
          .fn()
          .mockResolvedValueOnce(modelResponse(JSON.stringify(validOrchestratorPayload())))
          .mockResolvedValueOnce(modelResponse(haltText))
      };

      const orchestrated = await orchestrateIntent(root, {
        intentId: intent.intent_id,
        modelClient
      });
      await recordApproval(root, {
        deploymentId: orchestrated.deployment_id,
        approver: "test",
        decision: "approved",
        scope: "Run."
      });

      const result = await runDeployment(root, {
        deploymentId: orchestrated.deployment_id,
        modelClient
      });

      expect(result.completed).toEqual([]);
      expect(result.failed).toEqual(["T-001"]);

      const tasks = await loadJson(root, "state/task_board.json");
      const task = tasks.tasks.find((entry: { task_id: string }) => entry.task_id === "T-001");
      expect(task.status).toBe("blocked");
      expect(task.blocker).toMatch(/^HALT:/);

      const chat = await loadJson(root, "state/chat.json");
      const haltMessage = chat.messages.find((entry: { summary: string }) =>
        entry.summary.includes("Model halted")
      );
      expect(haltMessage).toBeDefined();
      expect(haltMessage.requires_action).toBe(true);
      expect(haltMessage.summary).toContain(
        "Source data is contradictory; refusing to fabricate convergence."
      );

      const artifacts = await loadJson(root, "artifacts/artifact_index.json");
      const haltArtifact = artifacts.artifacts.find(
        (entry: { task_id: string }) => entry.task_id === "T-001"
      );
      expect(haltArtifact.type).toBe("model_halt");

      // No model_output artifact registered; reviewers were not called.
      const modelOutput = artifacts.artifacts.find(
        (entry: { task_id: string; type: string }) =>
          entry.task_id === "T-001" && entry.type === "model_output"
      );
      expect(modelOutput).toBeUndefined();

      // Two model calls only: orchestrate + halted task. No reviewer calls.
      expect(modelClient.createResponse).toHaveBeenCalledTimes(2);
    });
  });

  test("model agent with web_search allowed receives hosted web search tool", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await registerAgent(root, {
        agent_id: "researcher_1",
        role: "Research Agent",
        executor_type: "model_agent",
        model_tier: "mid",
        allowed_tools: ["web_search"],
        command_allowlist: [],
        permissions: {
          external_actions: true,
          destructive_actions: false,
          credential_access: false,
          paid_actions: false,
          public_actions: false
        },
        max_cost_usd: 1
      });
      await saveJson(root, "state/task_board.json", {
        tasks: [
          {
            task_id: "T-001",
            title: "Research current information",
            owner_agent_id: "researcher_1",
            owner_role: "Research Agent",
            executor: "model_agent",
            model_tier: "mid",
            input_context: ["state/prompt_contract.md"],
            output_required: "Current sourced brief",
            acceptance_criteria: ["Brief cites current information"],
            dependencies: [],
            risk_level: "low",
            review_required: false,
            approval_required: false,
            status: "queued",
            artifacts: [],
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
                agent_id: "researcher_1",
                executor: "model_agent",
                model_tier: "mid",
                reason: "Researcher can use hosted web search for current facts.",
                approval_required: false
              }
            ],
            created_at: "2026-05-08T00:00:00.000Z",
            updated_at: "2026-05-08T00:00:00.000Z"
          }
        ]
      });

      const modelClient = {
        createResponse: vi.fn().mockResolvedValue(modelResponse("current sourced brief"))
      };
      await runDeployment(root, { deploymentId: "DP-001", modelClient });

      const request = modelClient.createResponse.mock.calls[0]?.[0];
      expect(request.tools).toEqual([{ type: "web_search" }]);
      expect(request.toolChoice).toBe("auto");
      expect(request.include).toEqual(["web_search_call.action.sources"]);
      expect(request.instructions).toContain("provided hosted tools");
    });
  });

  test("HALT marker only triggers when at the very start of the response", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const intent = await createIntent(root, { text: "Build something." });
      // Mid-paragraph "HALT:" should not trigger; this is a normal completion.
      const normalText =
        "Implementation draft for the task.\n\nNote: the agent considered HALT: in its analysis but proceeded.\n";
      const modelClient = {
        createResponse: vi
          .fn()
          .mockResolvedValueOnce(modelResponse(JSON.stringify(validOrchestratorPayload())))
          .mockResolvedValueOnce(modelResponse(normalText))
      };

      const orchestrated = await orchestrateIntent(root, {
        intentId: intent.intent_id,
        modelClient
      });
      await recordApproval(root, {
        deploymentId: orchestrated.deployment_id,
        approver: "test",
        decision: "approved",
        scope: "Run."
      });

      const result = await runDeployment(root, {
        deploymentId: orchestrated.deployment_id,
        modelClient
      });

      expect(result.completed).toEqual(["T-001"]);
      expect(result.failed).toEqual([]);

      const artifacts = await loadJson(root, "artifacts/artifact_index.json");
      const output = artifacts.artifacts.find(
        (entry: { task_id: string; type: string }) =>
          entry.task_id === "T-001" && entry.type === "model_output"
      );
      expect(output).toBeDefined();
    });
  });

  test("orchestrator refuses to re-orchestrate an intent that already has a deployment", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const intent = await createIntent(root, { text: "Build a verified demo artifact." });
      const modelClient = {
        createResponse: vi.fn().mockResolvedValue(modelResponse(JSON.stringify(validOrchestratorPayload())))
      };

      await orchestrateIntent(root, { intentId: intent.intent_id, modelClient });

      await expect(
        orchestrateIntent(root, { intentId: intent.intent_id, modelClient })
      ).rejects.toThrow(
        /^Intent I-001 cannot be re-orchestrated \(status: planned\)\. Existing deployments: DP-001\.$/
      );

      const plans = await loadJson(root, "state/deployment_plan.json");
      const tasks = await loadJson(root, "state/task_board.json");
      expect(plans.deployment_plans).toHaveLength(1);
      expect(tasks.tasks).toHaveLength(1);
      expect(modelClient.createResponse).toHaveBeenCalledTimes(1);
    });
  });

  test("orchestrator refuses an intent that has a deployment even when intent.status is still new (partial-write recovery)", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const intent = await createIntent(root, { text: "Build a verified demo artifact." });
      const modelClient = {
        createResponse: vi.fn().mockResolvedValue(modelResponse(JSON.stringify(validOrchestratorPayload())))
      };

      await orchestrateIntent(root, { intentId: intent.intent_id, modelClient });

      // Simulate a crash between deployment_plan write and intent_queue write:
      // deployment exists on disk but intent.status is reset to "new".
      const queue = await loadJson(root, "state/intent_queue.json");
      queue.intents[0].status = "new";
      await saveJson(root, "state/intent_queue.json", queue);

      await expect(
        orchestrateIntent(root, { intentId: intent.intent_id, modelClient })
      ).rejects.toThrow(
        /^Intent I-001 cannot be re-orchestrated \(status: new\)\. Existing deployments: DP-001\.$/
      );

      const plans = await loadJson(root, "state/deployment_plan.json");
      const tasks = await loadJson(root, "state/task_board.json");
      expect(plans.deployment_plans).toHaveLength(1);
      expect(tasks.tasks).toHaveLength(1);
      expect(modelClient.createResponse).toHaveBeenCalledTimes(1);
    });
  });

  test("orchestrator removes the empty decision-log placeholder before appending decisions", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const intent = await createIntent(root, { text: "Record a decision." });
      const modelClient = {
        createResponse: vi.fn().mockResolvedValue(modelResponse(JSON.stringify(validOrchestratorPayload())))
      };

      await orchestrateIntent(root, {
        intentId: intent.intent_id,
        modelClient
      });

      const decisions = await readFile(join(root, "state/decision_log.md"), "utf8");
      expect(decisions).not.toContain("No decisions recorded yet.");
      expect(decisions).toContain("Use local registered agents");
    });
  });

  test("active learning rules appear in the orchestrator prompt", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await saveJson(root, "state/learning_memory.json", {
        learning_rules: [
          {
            rule_id: "LR-001",
            trigger: "DRY_RUN_DELIVERABLE",
            rule: "Do not route deliverable tasks to dry_run.",
            source: "DP-001/T-001/DRY_RUN_DELIVERABLE",
            confidence: 0.9,
            created_at: "2026-05-08T00:00:00.000Z",
            last_seen_at: "2026-05-08T00:00:02.000Z",
            times_seen: 2,
            sources_seen: ["DP-001/T-001/DRY_RUN_DELIVERABLE"]
          },
          {
            rule_id: "LR-002",
            trigger: "LOW_CONFIDENCE_RULE",
            rule: "This rule should stay out of the prompt.",
            source: "DP-001/T-002/LOW_CONFIDENCE_RULE",
            confidence: 0.4,
            created_at: "2026-05-08T00:00:00.000Z",
            last_seen_at: "2026-05-08T00:00:03.000Z",
            times_seen: 2,
            sources_seen: ["DP-001/T-002/LOW_CONFIDENCE_RULE"]
          }
        ]
      });
      const intent = await createIntent(root, { text: "Build with learned constraints." });
      const modelClient = {
        createResponse: vi.fn().mockResolvedValue(modelResponse(JSON.stringify(validOrchestratorPayload())))
      };

      await orchestrateIntent(root, { intentId: intent.intent_id, modelClient });

      const instructions = modelClient.createResponse.mock.calls[0]?.[0].instructions ?? "";
      expect(instructions).toContain("Active learning rules from prior runs");
      expect(instructions).toContain("Do not route deliverable tasks to dry_run.");
      expect(instructions).toContain("DRY_RUN_DELIVERABLE");
      expect(instructions).not.toContain("This rule should stay out of the prompt.");
      expect(instructions).not.toContain("LOW_CONFIDENCE_RULE");
    });
  });

  test("no-rule workspace still orchestrates without a learning-rule prompt section", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await saveJson(root, "state/learning_memory.json", { learning_rules: [] });
      const intent = await createIntent(root, { text: "Build without prior memory." });
      const modelClient = {
        createResponse: vi.fn().mockResolvedValue(modelResponse(JSON.stringify(validOrchestratorPayload())))
      };

      const result = await orchestrateIntent(root, { intentId: intent.intent_id, modelClient });

      const instructions = modelClient.createResponse.mock.calls[0]?.[0].instructions ?? "";
      expect(result.deployment_id).toBe("DP-001");
      expect(instructions).not.toContain("Active learning rules from prior runs");
    });
  });

  test("performance suffix appears in orchestrator input when agent data exists", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const registry = await loadJson(root, "state/agent_registry.json");
      const researcher = registry.agents.find((agent: { agent_id: string }) => agent.agent_id === "researcher_1");
      researcher.performance = {
        tasks_assigned: 5,
        tasks_completed: 5,
        tasks_failed: 0,
        review_passes: 4,
        review_failures: 1,
        dry_run_deliverable_mismatches: 2,
        average_score_contribution: 1,
        known_failure_modes: []
      };
      await saveJson(root, "state/agent_registry.json", registry);
      const intent = await createIntent(root, { text: "Use performance-aware input." });
      const modelClient = {
        createResponse: vi.fn().mockResolvedValue(modelResponse(JSON.stringify(validOrchestratorPayload())))
      };

      await orchestrateIntent(root, { intentId: intent.intent_id, modelClient });

      const input = modelClient.createResponse.mock.calls[0]?.[0].input ?? "";
      expect(input).toContain(
        "- researcher_1: Research Agent; executor=model_agent; tier=mid; assigned=5 completed=5 failed=0 reviews=4/1 dry_run_mismatches=2"
      );
    });
  });

  test("performance suffix is omitted for cold-start agents", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const intent = await createIntent(root, { text: "Keep cold-start agents routable." });
      const modelClient = {
        createResponse: vi.fn().mockResolvedValue(modelResponse(JSON.stringify(validOrchestratorPayload())))
      };

      await orchestrateIntent(root, { intentId: intent.intent_id, modelClient });

      const input = modelClient.createResponse.mock.calls[0]?.[0].input ?? "";
      expect(input).toContain("- reviewer_skeptical: Reviewer Agent; executor=model_agent; tier=high");
      expect(input).not.toMatch(/reviewer_skeptical: .*assigned=/);
      expect(input).not.toMatch(/reviewer_completeness: .*assigned=/);
      expect(input).not.toMatch(/reviewer_rigor: .*assigned=/);
    });
  });

  test("pre-flight validation passes clean plans without retry or synthetic decision", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const intent = await createIntent(root, { text: "Build a clean plan." });
      const modelClient = {
        createResponse: vi.fn().mockResolvedValue(modelResponse(JSON.stringify(validOrchestratorPayload())))
      };

      await orchestrateIntent(root, { intentId: intent.intent_id, modelClient });

      const decisions = await readFile(join(root, "state/decision_log.md"), "utf8");
      expect(modelClient.createResponse).toHaveBeenCalledTimes(1);
      expect(decisions).not.toContain("Revised orchestrator plan to address pre-flight violations");
    });
  });

  test("pre-flight validation accepts review or synthesis tasks that depend on newly planned outputs", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const intent = await createIntent(root, { text: "Produce a source brief and synthesize it." });
      const modelClient = {
        createResponse: vi.fn().mockResolvedValue(modelResponse(JSON.stringify(synthesisPayloadWithNewDependency())))
      };

      const result = await orchestrateIntent(root, { intentId: intent.intent_id, modelClient });

      expect(result.task_ids).toEqual(["T-001", "T-002"]);
      expect(modelClient.createResponse).toHaveBeenCalledTimes(1);
    });
  });

  test("pre-flight validation retries a broken plan and persists the corrected plan", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const intent = await createIntent(root, { text: "Repair dry-run deliverable routing." });
      const modelClient = {
        createResponse: vi
          .fn()
          .mockResolvedValueOnce(modelResponse(JSON.stringify(brokenDryRunDeliverablePayload())))
          .mockResolvedValueOnce(modelResponse(JSON.stringify(validOrchestratorPayload())))
      };

      const result = await orchestrateIntent(root, { intentId: intent.intent_id, modelClient });

      const tasks = await loadJson(root, "state/task_board.json");
      const plans = await loadJson(root, "state/deployment_plan.json");
      const decisions = await readFile(join(root, "state/decision_log.md"), "utf8");
      expect(result.deployment_id).toBe("DP-001");
      expect(modelClient.createResponse).toHaveBeenCalledTimes(2);
      expect(tasks.tasks[0]).toMatchObject({
        task_id: "T-001",
        executor: "model_agent",
        owner_agent_id: "researcher_1"
      });
      expect(plans.deployment_plans[0].assignments[0]).toMatchObject({
        task_id: "T-001",
        executor: "model_agent",
        agent_id: "researcher_1"
      });
      expect(decisions).toContain("Revised orchestrator plan to address pre-flight violations");
      expect(decisions).toContain("DRY_RUN_DELIVERABLE");
    });
  });

  test("pre-flight validation retries when high-risk work is routed to a low-pass-rate agent", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const registry = await loadJson(root, "state/agent_registry.json");
      const researcher = registry.agents.find((agent: { agent_id: string }) => agent.agent_id === "researcher_1");
      researcher.performance = {
        tasks_assigned: 10,
        tasks_completed: 10,
        tasks_failed: 0,
        review_passes: 2,
        review_failures: 8,
        dry_run_deliverable_mismatches: 0,
        average_score_contribution: 0.2,
        known_failure_modes: []
      };
      await saveJson(root, "state/agent_registry.json", registry);
      const intent = await createIntent(root, { text: "Route high-risk work by performance." });
      const modelClient = {
        createResponse: vi
          .fn()
          .mockResolvedValueOnce(modelResponse(JSON.stringify(highRiskPayloadFor("researcher_1"))))
          .mockResolvedValueOnce(modelResponse(JSON.stringify(highRiskPayloadFor("reviewer_skeptical", "Reviewer Agent"))))
      };

      const result = await orchestrateIntent(root, { intentId: intent.intent_id, modelClient });

      const plans = await loadJson(root, "state/deployment_plan.json");
      const decisions = await readFile(join(root, "state/decision_log.md"), "utf8");
      const retryInput = modelClient.createResponse.mock.calls[1]?.[0].input ?? "";
      expect(result.deployment_id).toBe("DP-001");
      expect(modelClient.createResponse).toHaveBeenCalledTimes(2);
      expect(plans.deployment_plans[0].assignments[0].agent_id).toBe("reviewer_skeptical");
      expect(retryInput).toContain("LOW_REVIEW_PASS_RATE_FOR_RISK");
      expect(retryInput).toContain("researcher_1");
      expect(retryInput).toContain("0.20");
      expect(retryInput).toContain("0.5");
      expect(decisions).toContain("LOW_REVIEW_PASS_RATE_FOR_RISK");
    });
  });

  test("pre-flight validation throws after max retries without persisting broken state", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const intent = await createIntent(root, { text: "Keep returning a broken plan." });
      const modelClient = {
        createResponse: vi.fn().mockResolvedValue(modelResponse(JSON.stringify(brokenDryRunDeliverablePayload())))
      };

      await expect(orchestrateIntent(root, { intentId: intent.intent_id, modelClient })).rejects.toThrow(
        /DRY_RUN_DELIVERABLE/
      );

      const queue = await loadJson(root, "state/intent_queue.json");
      const tasks = await loadJson(root, "state/task_board.json");
      const plans = await loadJson(root, "state/deployment_plan.json");
      expect(modelClient.createResponse).toHaveBeenCalledTimes(3);
      expect(queue.intents[0].status).toBe("new");
      expect(tasks.tasks).toEqual([]);
      expect(plans.deployment_plans).toEqual([]);
    });
  });

  test("pre-flight retry accounting bills every orchestrator model call", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await saveJson(root, "state/model_config.json", {
        provider: "openai",
        base_url: "https://api.openai.com/v1",
        api_key_env: "OPENAI_API_KEY",
        default_models: {
          orchestrator: "priced-orchestrator",
          high: "gpt-5.2",
          mid: "gpt-5-mini",
          low: "gpt-5-nano"
        },
        max_output_tokens: 4000,
        learning_rule_threshold: 1.6,
        orchestrator_max_retries: 2,
        learning_rule_cap: 10,
        pricing: {
          "priced-orchestrator": {
            input_per_1m_usd: 1,
            output_per_1m_usd: 2
          }
        }
      });
      const intent = await createIntent(root, { text: "Bill failed retries." });
      const modelClient = {
        createResponse: vi.fn().mockResolvedValue(
          modelResponse(JSON.stringify(brokenDryRunDeliverablePayload()), {
            usage: { input_tokens: 1000, output_tokens: 500 }
          })
        )
      };

      await expect(orchestrateIntent(root, { intentId: intent.intent_id, modelClient })).rejects.toThrow(
        /DRY_RUN_DELIVERABLE/
      );

      const metrics = await loadJson(root, "state/metrics.json");
      expect(modelClient.createResponse).toHaveBeenCalledTimes(3);
      expect(metrics.model_calls).toBe(3);
      expect(metrics.estimated_cost_usd).toBeCloseTo(0.006);
    });
  });

  test("collectPlanIssues is pure and does not write plan-check records", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await saveJson(root, "state/plan_checks.json", {
        plan_checks: [
          {
            check_id: "PC-999",
            deployment_id: "DP-999",
            status: "pass",
            issues: [],
            created_at: "2026-05-08T00:00:00.000Z"
          }
        ]
      });
      const permissions = {
        external_actions: false,
        destructive_actions: false,
        credential_access: false,
        paid_actions: false,
        public_actions: false
      };
      const issues = collectPlanIssues({
        plan: {
          deployment_id: "DP-001",
          intent_id: "I-001",
          status: "proposed",
          approval_required: true,
          assignments: [
            {
              task_id: "T-001",
              agent_id: "builder_1",
              executor: "dry_run",
              model_tier: "mid",
              reason: "Broken dry-run routing.",
              approval_required: false
            }
          ],
          created_at: "2026-05-08T00:00:00.000Z",
          updated_at: "2026-05-08T00:00:00.000Z"
        },
        tasks: [
          {
            task_id: "T-001",
            title: "Draft implementation artifact",
            owner_agent_id: "builder_1",
            owner_role: "Builder Agent",
            executor: "dry_run",
            model_tier: "mid",
            input_context: [],
            output_required: "Implementation draft",
            acceptance_criteria: ["Draft addresses the prompt contract"],
            dependencies: [],
            risk_level: "medium",
            review_required: false,
            approval_required: false,
            status: "queued",
            artifacts: [],
            deployment_id: "DP-001",
            created_at: "2026-05-08T00:00:00.000Z",
            updated_at: "2026-05-08T00:00:00.000Z"
          }
        ],
        registry: {
          agents: [
            {
              agent_id: "builder_1",
              role: "Builder Agent",
              executor_type: "dry_run",
              model_tier: "mid",
              allowed_tools: [],
              command_allowlist: [],
              permissions,
              max_cost_usd: 0
            }
          ]
        },
        artifactIndex: { artifacts: [] }
      });

      const checks = await loadJson(root, "state/plan_checks.json");
      expect(issues.map((issue) => issue.code)).toContain("DRY_RUN_DELIVERABLE");
      expect(checks.plan_checks).toHaveLength(1);
      expect(checks.plan_checks[0].check_id).toBe("PC-999");
    });
  });

  test("orchestrator rejects invalid plans before mutating task state", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const intent = await createIntent(root, { text: "Make a broken plan." });
      const modelClient = {
        createResponse: vi.fn().mockResolvedValue(
          modelResponse(
            JSON.stringify({
            ...validOrchestratorPayload(),
            tasks: [
              {
                ...validOrchestratorPayload().tasks[0],
                acceptance_criteria: []
              }
            ]
            })
          )
        )
      };

      await expect(
        orchestrateIntent(root, { intentId: intent.intent_id, modelClient })
      ).rejects.toThrow(/acceptance/i);

      const tasks = await loadJson(root, "state/task_board.json");
      expect(tasks.tasks).toEqual([]);
    });
  });

  test("deployment execution is blocked until explicit approval is recorded", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const intent = await createIntent(root, { text: "Build with approval." });
      const modelClient = {
        createResponse: vi.fn().mockResolvedValue(modelResponse(JSON.stringify(validOrchestratorPayload())))
      };
      const { deployment_id } = await orchestrateIntent(root, {
        intentId: intent.intent_id,
        modelClient
      });

      await expect(runDeployment(root, { deploymentId: deployment_id })).rejects.toThrow(
        /approval/i
      );

      await recordApproval(root, {
        deploymentId: deployment_id,
        approver: "human",
        decision: "approved",
        scope: "Run the generated deployment plan."
      });

      const result = await runDeployment(root, {
        deploymentId: deployment_id,
        modelClient: {
          createResponse: vi.fn().mockResolvedValue(modelResponse("review passed"))
        }
      });

      expect(result.completed).toEqual(["T-001"]);
    });
  });

  test("completed deployment can be run again only with explicit rerun", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const intent = await createIntent(root, { text: "Rerun with approval." });
      const modelClient = {
        createResponse: vi.fn().mockResolvedValue(modelResponse(JSON.stringify(validOrchestratorPayload())))
      };
      const { deployment_id } = await orchestrateIntent(root, {
        intentId: intent.intent_id,
        modelClient
      });
      await recordApproval(root, {
        deploymentId: deployment_id,
        approver: "human",
        decision: "approved",
        scope: "Run once."
      });
      await runDeployment(root, {
        deploymentId: deployment_id,
        modelClient: { createResponse: vi.fn().mockResolvedValue(modelResponse("review output")) }
      });

      await expect(
        runDeployment(root, {
          deploymentId: deployment_id,
          modelClient: { createResponse: vi.fn().mockResolvedValue(modelResponse("review output")) }
        })
      ).rejects.toThrow(/not approved/i);

      const rerun = await runDeployment(root, {
        deploymentId: deployment_id,
        rerun: true,
        modelClient: { createResponse: vi.fn().mockResolvedValue(modelResponse("review output")) }
      });

      expect(rerun.completed).toEqual(["T-001"]);
    });
  });

  test("failed adapter execution marks the deployment failed instead of leaving it running", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const intent = await createIntent(root, { text: "Fail during execution." });
      const modelClient = {
        createResponse: vi.fn().mockResolvedValue(modelResponse(JSON.stringify(validOrchestratorPayload())))
      };
      const { deployment_id } = await orchestrateIntent(root, {
        intentId: intent.intent_id,
        modelClient
      });
      await recordApproval(root, {
        deploymentId: deployment_id,
        approver: "human",
        decision: "approved",
        scope: "Run failing deployment."
      });

      const result = await runDeployment(root, {
        deploymentId: deployment_id,
        modelClient: {
          createResponse: vi.fn().mockRejectedValue(new Error("quota exhausted"))
        }
      });

      const plans = await loadJson(root, "state/deployment_plan.json");
      const tasks = await loadJson(root, "state/task_board.json");
      expect(result.failed).toEqual(["T-001"]);
      expect(plans.deployment_plans[0].status).toBe("failed");
      expect(tasks.tasks[0].status).toBe("failed");
    });
  });

  test("rerun resolves stale task and chat blockers after a recovered model task succeeds", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await seedApprovedDeployment(
        root,
        [workflowTask()],
        [workflowAssignment()]
      );

      const firstRun = await runDeployment(root, {
        deploymentId: "DP-001",
        modelClient: {
          createResponse: vi.fn().mockRejectedValue(new Error("quota exhausted"))
        }
      });
      expect(firstRun.failed).toEqual(["T-001"]);

      const rerun = await runDeployment(root, {
        deploymentId: "DP-001",
        rerun: true,
        modelClient: {
          createResponse: vi.fn().mockResolvedValue(modelResponse("recovered output"))
        }
      });

      const tasks = await loadJson(root, "state/task_board.json");
      const chat = await loadJson(root, "state/chat.json");
      const task = tasks.tasks.find((entry: { task_id: string }) => entry.task_id === "T-001");
      const blocker = chat.messages.find(
        (entry: { task_id?: string; type: string }) =>
          entry.task_id === "T-001" && entry.type === "blocker"
      );

      expect(rerun.completed).toEqual(["T-001"]);
      expect(task).not.toHaveProperty("blocker");
      expect(blocker.requires_action).toBe(false);
      expect(blocker.summary).toMatch(/^\[RESOLVED /);
      expect(blocker.summary).toContain("quota exhausted");
    });
  });

  test("rerun that fails again does not prematurely resolve the original chat blocker", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await seedApprovedDeployment(
        root,
        [workflowTask()],
        [workflowAssignment()]
      );

      const firstRun = await runDeployment(root, {
        deploymentId: "DP-001",
        modelClient: {
          createResponse: vi.fn().mockRejectedValue(new Error("quota exhausted"))
        }
      });
      expect(firstRun.failed).toEqual(["T-001"]);

      const firstChat = await loadJson(root, "state/chat.json");
      expect(firstChat.messages).toHaveLength(1);
      expect(firstChat.messages[0].requires_action).toBe(true);
      expect(firstChat.messages[0].summary).not.toContain("[RESOLVED");

      const secondRun = await runDeployment(root, {
        deploymentId: "DP-001",
        rerun: true,
        modelClient: {
          createResponse: vi.fn().mockRejectedValue(new Error("quota still exhausted"))
        }
      });
      expect(secondRun.failed).toEqual(["T-001"]);

      const secondChat = await loadJson(root, "state/chat.json");
      expect(secondChat.messages).toHaveLength(2);
      expect(secondChat.messages[0].requires_action).toBe(true);
      expect(secondChat.messages[0].summary).not.toContain("[RESOLVED");

      const recoveredRun = await runDeployment(root, {
        deploymentId: "DP-001",
        rerun: true,
        modelClient: {
          createResponse: vi.fn().mockResolvedValue(modelResponse("recovered output"))
        }
      });

      const resolvedChat = await loadJson(root, "state/chat.json");
      expect(recoveredRun.completed).toEqual(["T-001"]);
      expect(resolvedChat.messages).toHaveLength(2);
      for (const message of resolvedChat.messages) {
        expect(message.requires_action).toBe(false);
        expect(message.summary).toMatch(/^\[RESOLVED /);
      }
    });
  });

  test("truncated model output is saved, sidecared, and recorded as a blocker", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await seedApprovedDeployment(
        root,
        [workflowTask()],
        [workflowAssignment()]
      );

      const result = await runDeployment(root, {
        deploymentId: "DP-001",
        modelClient: {
          createResponse: vi.fn().mockResolvedValue(
            modelResponse("partial answer", {
              truncated: true,
              status: "incomplete",
              reason: "max_output_tokens"
            })
          )
        }
      });

      const tasks = await loadJson(root, "state/task_board.json");
      const chat = await loadJson(root, "state/chat.json");
      const artifacts = await loadJson(root, "artifacts/artifact_index.json");
      const sidecar = await loadJson(root, "artifacts/runs/T-001/output_truncated.json");
      const partial = await readFile(join(root, "artifacts/runs/T-001/response_output.md"), "utf8");

      expect(result.failed).toEqual(["T-001"]);
      expect(tasks.tasks[0].status).toBe("failed");
      expect(artifacts.artifacts.filter((artifact: { task_id: string }) => artifact.task_id === "T-001")).toHaveLength(0);
      expect(tasks.tasks[0].artifacts).toEqual([]);
      expect(sidecar).toMatchObject({
        reason: "max_output_tokens",
        max_output_tokens: 4000,
        response_chars: "partial answer".length
      });
      expect(partial).toContain("partial answer");
      expect(chat.messages[0]).toMatchObject({
        task_id: "T-001",
        type: "blocker",
        requires_action: true,
        summary: "Model response truncated at max_output_tokens (4000)."
      });
    });
  });

  test("deployment continues independent branches after a task failure", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await seedApprovedDeployment(
        root,
        [
          workflowTask({
            task_id: "T-001",
            title: "First dry run",
            owner_agent_id: "builder_1",
            owner_role: "Builder Agent",
            executor: "dry_run",
            model_tier: "mid"
          }),
          workflowTask({
            task_id: "T-002",
            title: "Failing model task",
            dependencies: ["T-001"]
          }),
          workflowTask({
            task_id: "T-003",
            title: "Independent dry run",
            owner_agent_id: "builder_1",
            owner_role: "Builder Agent",
            executor: "dry_run",
            model_tier: "mid"
          })
        ],
        [
          workflowAssignment({
            task_id: "T-001",
            agent_id: "builder_1",
            executor: "dry_run",
            model_tier: "mid"
          }),
          workflowAssignment({ task_id: "T-002" }),
          workflowAssignment({
            task_id: "T-003",
            agent_id: "builder_1",
            executor: "dry_run",
            model_tier: "mid"
          })
        ]
      );

      const result = await runDeployment(root, {
        deploymentId: "DP-001",
        modelClient: {
          createResponse: vi.fn().mockRejectedValue(new Error("adapter exploded"))
        }
      });

      const plans = await loadJson(root, "state/deployment_plan.json");
      const tasks = await loadJson(root, "state/task_board.json");

      expect(result.completed).toEqual(["T-001", "T-003"]);
      expect(result.failed).toEqual(["T-002"]);
      expect(plans.deployment_plans[0].status).toBe("failed");
      expect(tasks.tasks.find((task: { task_id: string }) => task.task_id === "T-003").status).toBe(
        "completed"
      );
    });
  });

  test("deployment blocks downstream branches when an upstream task failed", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await seedApprovedDeployment(
        root,
        [
          workflowTask({
            task_id: "T-001",
            title: "First dry run",
            owner_agent_id: "builder_1",
            owner_role: "Builder Agent",
            executor: "dry_run",
            model_tier: "mid"
          }),
          workflowTask({
            task_id: "T-002",
            title: "Failing model task",
            dependencies: ["T-001"]
          }),
          workflowTask({
            task_id: "T-003",
            title: "Dependent dry run",
            owner_agent_id: "builder_1",
            owner_role: "Builder Agent",
            executor: "dry_run",
            model_tier: "mid",
            dependencies: ["T-002"]
          })
        ],
        [
          workflowAssignment({
            task_id: "T-001",
            agent_id: "builder_1",
            executor: "dry_run",
            model_tier: "mid"
          }),
          workflowAssignment({ task_id: "T-002" }),
          workflowAssignment({
            task_id: "T-003",
            agent_id: "builder_1",
            executor: "dry_run",
            model_tier: "mid"
          })
        ]
      );

      const result = await runDeployment(root, {
        deploymentId: "DP-001",
        modelClient: {
          createResponse: vi.fn().mockRejectedValue(new Error("adapter exploded"))
        }
      });

      const tasks = await loadJson(root, "state/task_board.json");
      const downstream = tasks.tasks.find((task: { task_id: string }) => task.task_id === "T-003");

      expect(result.completed).toEqual(["T-001"]);
      expect(result.failed).toEqual(["T-002", "T-003"]);
      expect(downstream.status).toBe("blocked");
      expect(downstream.blocker).toBe("Upstream task T-002 failed");
    });
  });

  test("known model pricing increments estimated cost for model-agent calls", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await saveJson(root, "state/model_config.json", {
        provider: "openai",
        base_url: "https://api.openai.com/v1",
        api_key_env: "OPENAI_API_KEY",
        default_models: {
          orchestrator: "gpt-5.2",
          high: "priced-model",
          mid: "gpt-5-mini",
          low: "gpt-5-nano"
        },
        max_output_tokens: 4000,
        pricing: {
          "priced-model": {
            input_per_1m_usd: 2,
            output_per_1m_usd: 8
          }
        }
      });
      await seedApprovedDeployment(
        root,
        [workflowTask()],
        [workflowAssignment()]
      );

      await runDeployment(root, {
        deploymentId: "DP-001",
        modelClient: {
          createResponse: vi.fn().mockResolvedValue(
            modelResponse("priced output", {
              usage: { input_tokens: 1000, output_tokens: 500 }
            })
          )
        }
      });

      const metrics = await loadJson(root, "state/metrics.json");
      expect(metrics.estimated_cost_usd).toBeCloseTo(0.006);
    });
  });

  test("dry-run adapter emits a delegation packet without external execution", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const intent = await createIntent(root, { text: "Dry run only." });
      const modelClient = {
        createResponse: vi.fn().mockResolvedValue(modelResponse(JSON.stringify(dryRunPacketPayload())))
      };
      const { deployment_id } = await orchestrateIntent(root, {
        intentId: intent.intent_id,
        modelClient
      });
      await recordApproval(root, {
        deploymentId: deployment_id,
        approver: "human",
        decision: "approved",
        scope: "Run dry-run deployment."
      });

      await runDeployment(root, {
        deploymentId: deployment_id,
        modelClient: { createResponse: vi.fn().mockResolvedValue(modelResponse("review output")) }
      });

      const packet = await readFile(
        join(root, "artifacts/runs/T-001/delegation_packet.md"),
        "utf8"
      );
      expect(packet).toContain("TASK: Draft implementation artifact");
      expect(packet).toContain("ROLE: Builder Agent");
    });
  });

  test("local-command adapter requires execute flag and per-agent allowlist", async () => {
    await withWorkspace(async (root) => {
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
          public_actions: false
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
                reason: "Verify command adapter.",
                approval_required: false
              }
            ],
            created_at: "2026-05-08T00:00:00.000Z",
            updated_at: "2026-05-08T00:00:00.000Z"
          }
        ]
      });

      await expect(runDeployment(root, { deploymentId: "DP-001" })).rejects.toThrow(
        /--execute/i
      );

      await runDeployment(root, { deploymentId: "DP-001", execute: true });

      const output = await readFile(join(root, "artifacts/runs/T-001/command_output.txt"), "utf8");
      expect(output.trim()).toBe("ok");
    });
  });

  test("model-agent adapter sends scoped context and excludes unrelated state", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await saveJson(root, "state/chat.json", {
        messages: [
          {
            message_id: "M-001",
            timestamp: "2026-05-08T00:00:00.000Z",
            from_agent: "orchestrator",
            to: "runner",
            type: "status",
            summary: "DO-NOT-SEND",
            details: "",
            requires_action: false,
            recommended_next_step: ""
          }
        ]
      });
      await saveJson(root, "state/task_board.json", {
        tasks: [
          {
            task_id: "T-001",
            title: "Review scoped contract",
            owner_agent_id: "reviewer_skeptical",
            owner_role: "Reviewer Agent",
            executor: "model_agent",
            model_tier: "high",
            input_context: ["state/prompt_contract.md"],
            output_required: "Review output",
            acceptance_criteria: ["Review uses only scoped context"],
            dependencies: [],
            risk_level: "medium",
            review_required: false,
            approval_required: false,
            status: "queued",
            artifacts: [],
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
                agent_id: "reviewer_skeptical",
                executor: "model_agent",
                model_tier: "high",
                reason: "Test scoped model input.",
                approval_required: false
              }
            ],
            created_at: "2026-05-08T00:00:00.000Z",
            updated_at: "2026-05-08T00:00:00.000Z"
          }
        ]
      });

      const modelClient = { createResponse: vi.fn().mockResolvedValue(modelResponse("scoped review")) };
      await runDeployment(root, { deploymentId: "DP-001", modelClient });

      const firstCall = modelClient.createResponse.mock.calls[0];
      expect(firstCall).toBeDefined();
      const input = firstCall![0].input;
      expect(input).toContain("Prompt Contract");
      expect(input).toContain("Review scoped contract");
      expect(input).not.toContain("DO-NOT-SEND");
    });
  });

  test("model-agent scoped context includes transitive dependency artifacts", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await saveText(root, "artifacts/upstream.md", "UPSTREAM DELIVERABLE");
      await saveJson(root, "state/task_board.json", {
        tasks: [
          {
            task_id: "T-001",
            title: "Upstream research",
            owner_agent_id: "researcher_1",
            owner_role: "Research Agent",
            executor: "model_agent",
            model_tier: "mid",
            input_context: ["state/prompt_contract.md"],
            output_required: "Research",
            acceptance_criteria: ["Research exists"],
            dependencies: [],
            risk_level: "medium",
            review_required: false,
            approval_required: false,
            status: "completed",
            artifacts: [],
            created_at: "2026-05-08T00:00:00.000Z",
            updated_at: "2026-05-08T00:00:00.000Z"
          },
          {
            task_id: "T-002",
            title: "Review upstream work",
            owner_agent_id: "reviewer_skeptical",
            owner_role: "Reviewer Agent",
            executor: "model_agent",
            model_tier: "high",
            input_context: ["state/prompt_contract.md"],
            output_required: "Review",
            acceptance_criteria: ["Review sees upstream artifact"],
            dependencies: ["T-001"],
            risk_level: "medium",
            review_required: false,
            approval_required: false,
            status: "queued",
            artifacts: [],
            created_at: "2026-05-08T00:00:00.000Z",
            updated_at: "2026-05-08T00:00:00.000Z"
          }
        ]
      });
      await addArtifact(root, {
        taskId: "T-001",
        path: "artifacts/upstream.md",
        type: "model_output",
        description: "Upstream artifact"
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
                task_id: "T-002",
                agent_id: "reviewer_skeptical",
                executor: "model_agent",
                model_tier: "high",
                reason: "Review dependency artifacts.",
                approval_required: false
              }
            ],
            created_at: "2026-05-08T00:00:00.000Z",
            updated_at: "2026-05-08T00:00:00.000Z"
          }
        ]
      });

      const modelClient = { createResponse: vi.fn().mockResolvedValue(modelResponse("review output")) };
      await runDeployment(root, { deploymentId: "DP-001", modelClient });

      const firstCall = modelClient.createResponse.mock.calls[0];
      expect(firstCall).toBeDefined();
      expect(firstCall![0].input).toContain("UPSTREAM DELIVERABLE");
    });
  });

  test("model-agent scoped context turns review-sensitive acceptance criteria into hard output guidance", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await seedApprovedDeployment(
        root,
        [
          workflowTask({
            owner_agent_id: "researcher_1",
            owner_role: "Research Agent",
            agent_id: "researcher_1",
            acceptance_criteria: [
              "Lists tradeoffs (latency/cost/reliability) for each option",
              "Roadmap has milestones, dependencies, and evaluation gates"
            ],
            output_required: "A pattern library and roadmap",
            review_required: false
          })
        ],
        [
          workflowAssignment({
            agent_id: "researcher_1",
            reason: "Exercise acceptance guidance."
          })
        ]
      );

      const modelClient = { createResponse: vi.fn().mockResolvedValue(modelResponse("guided output")) };
      await runDeployment(root, { deploymentId: "DP-001", modelClient });

      const firstCall = modelClient.createResponse.mock.calls[0];
      expect(firstCall).toBeDefined();
      const input = firstCall![0].input;
      expect(input).toContain("ACCEPTANCE CONTRACT:");
      expect(input).toContain("For every option/pattern/architecture you list, include separate Tradeoffs bullets for Latency, Cost, and Reliability.");
      expect(input).toContain("For every roadmap phase or milestone, include explicit Dependencies and Evaluation gate/exit criteria.");
      expect(input).toContain("Do not combine required dimensions into one bullet.");
      expect(input).toContain("Do not write N/A for Latency, Cost, or Reliability.");
      expect(input).toContain("If a dimension is offline or indirect, state the concrete impact instead.");
    });
  });

  test("model-agent output normalizes tradeoff dimension bullets when acceptance requires them", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await seedApprovedDeployment(
        root,
        [
          workflowTask({
            owner_agent_id: "researcher_1",
            owner_role: "Research Agent",
            agent_id: "researcher_1",
            acceptance_criteria: ["Lists tradeoffs (latency/cost/reliability) for each option"],
            output_required: "Pattern library",
            review_required: false
          })
        ],
        [
          workflowAssignment({
            agent_id: "researcher_1",
            reason: "Exercise tradeoff normalization."
          })
        ]
      );
      const modelClient = {
        createResponse: vi.fn().mockResolvedValue(
          modelResponse(
            [
              "9) Memory variants",
              "- Episodic project memory",
              "  - Latency: retrieval scoped to project limits search time.",
              "  - Cost: modest storage cost.",
              "  - Reliability: strong for audit trails."
            ].join("\n")
          )
        )
      };

      await runDeployment(root, { deploymentId: "DP-001", modelClient });

      const output = await readFile(join(root, "artifacts/runs/T-001/response_output.md"), "utf8");
      expect(output).toContain("  - Tradeoffs — Latency: retrieval scoped to project limits search time.");
      expect(output).toContain("  - Tradeoffs — Cost: modest storage cost.");
      expect(output).toContain("  - Tradeoffs — Reliability: strong for audit trails.");
    });
  });

  test("recordReview stores pass and fail review entries", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);

      const review = await recordReview(root, {
        taskId: "T-001",
        reviewer: "reviewer_skeptical",
        status: "pass",
        issues: []
      });

      const log = await loadJson(root, "state/review_log.json");
      expect(review.review_id).toBe("R-001");
      expect(log.reviews[0]).toMatchObject({
        review_id: "R-001",
        task_id: "T-001",
        reviewer_agent_id: "reviewer_skeptical",
        reviewer_persona: "default",
        status: "pass"
      });
    });
  });

  test("validate catches missing owners, missing approvals, missing reviews, and orphan artifacts", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await saveJson(root, "state/task_board.json", {
        tasks: [
          {
            task_id: "T-001",
            title: "Broken task",
            owner_agent_id: "missing_agent",
            owner_role: "Builder Agent",
            executor: "dry_run",
            model_tier: "mid",
            input_context: [],
            output_required: "Output",
            acceptance_criteria: ["One criterion"],
            dependencies: ["T-999"],
            risk_level: "high",
            review_required: true,
            approval_required: true,
            status: "completed",
            artifacts: ["ART-404"],
            created_at: "2026-05-08T00:00:00.000Z",
            updated_at: "2026-05-08T00:00:00.000Z"
          }
        ]
      });

      const result = await validateWorkspace(root);
      expect(result.valid).toBe(false);
      expect(result.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining([
          "TASK_OWNER_MISSING",
          "TASK_DEPENDENCY_MISSING",
          "TASK_APPROVAL_MISSING",
          "TASK_REVIEW_MISSING",
          "ARTIFACT_MISSING"
        ])
      );
    });
  });

  test("report summarizes intent, deployment, task outcomes, approvals, decisions, and metrics", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const intent = await createIntent(root, { text: "Summarize workflow." });
      const modelClient = {
        createResponse: vi.fn().mockResolvedValue(modelResponse(JSON.stringify(validOrchestratorPayload())))
      };
      const { deployment_id } = await orchestrateIntent(root, {
        intentId: intent.intent_id,
        modelClient
      });
      await recordApproval(root, {
        deploymentId: deployment_id,
        approver: "human",
        decision: "approved",
        scope: "Generate report test."
      });
      await runDeployment(root, {
        deploymentId: deployment_id,
        modelClient: { createResponse: vi.fn().mockResolvedValue(modelResponse("review output")) }
      });

      const report = await generateReport(root);
      expect(report).toContain("Summarize workflow");
      expect(report).toContain("DP-001");
      expect(report).toContain("T-001");
      expect(report).toContain("approved");
      expect(report).toContain("Use local registered agents");
      expect(report).toContain("Model Calls");
    });
  });

  test("end-to-end honest review spawns persona reviews, computes consensus, and scores from consensus", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const intent = await createIntent(root, { text: "Produce an honestly verified brief." });
      const payload = {
        prompt_contract_markdown:
          "# Prompt Contract\n\nGoal: Produce an honestly verified brief.\n\nAcceptance Criteria:\n- Brief includes the required evidence claim.\n",
        tasks: [
          {
            title: "Draft verified brief",
            owner_agent_id: "researcher_1",
            owner_role: "Research Agent",
            executor: "model_agent",
            model_tier: "mid",
            input_context: ["state/prompt_contract.md"],
            output_required: "Evidence-backed brief",
            acceptance_criteria: ["Brief includes the required evidence claim"],
            dependencies: [],
            risk_level: "high",
            review_required: true,
            approval_required: false
          }
        ],
        deployment_plan: {
          approval_required: true,
          assignments: [
            {
              task_id: "T-001",
              agent_id: "researcher_1",
              executor: "model_agent",
              model_tier: "mid",
              reason: "Researcher produces the deliverable.",
              approval_required: false
            }
          ]
        },
        decisions: []
      };
      const reviewJson = (persona: string, artifactId: string) =>
        JSON.stringify({
          reviewer_persona: persona,
          status: "pass",
          per_criterion: [
            {
              criterion: "Brief includes the required evidence claim",
              verdict: "pass",
              citations: [{ artifact_id: artifactId, line_start: 1, line_end: 2 }],
              rationale: "" + (persona) + " verified the evidence span.",
              confidence: 0.9
            }
          ],
          identified_issues: [],
          free_form_assessment: "" + (persona) + " assessment"
        });
      const modelClient = {
        createResponse: vi.fn(async (request: { instructions: string; input: string }) => {
          if (request.instructions.includes("orchestrator agent")) {
            return modelResponse(JSON.stringify(payload));
          }
          if (request.instructions.includes("structured verification reviewer")) {
            const artifactId = /Artifact (ART-\d+)/.exec(request.input)?.[1] ?? "ART-001";
            if (request.instructions.includes("completeness reviewer")) {
              return modelResponse(reviewJson("completeness", artifactId));
            }
            if (request.instructions.includes("rigor reviewer")) {
              return modelResponse(reviewJson("rigor", artifactId));
            }
            return modelResponse(reviewJson("skeptical", artifactId));
          }
          return modelResponse("Required evidence claim\nsupporting line");
        })
      };

      const { deployment_id } = await orchestrateIntent(root, { intentId: intent.intent_id, modelClient });
      await recordApproval(root, {
        deploymentId: deployment_id,
        approver: "human",
        decision: "approved",
        scope: "Run honest verification."
      });
      await runDeployment(root, { deploymentId: deployment_id, modelClient });
      const score = await writeWorkflowScore(root, { deploymentId: deployment_id });

      const log = await loadJson(root, "state/review_log.json");
      const consensus = await loadJson(root, "state/consensus.json");
      const artifacts = await loadJson(root, "artifacts/artifact_index.json");
      expect(log.reviews).toHaveLength(3);
      expect(new Set(log.reviews.map((entry: { reviewer_persona: string }) => entry.reviewer_persona))).toEqual(
        new Set(["skeptical", "completeness", "rigor"])
      );
      expect(consensus.consensus_records[0]).toMatchObject({
        task_id: "T-001",
        overall_verdict: "pass",
        is_load_bearing: true
      });
      expect(score.verified_useful_outputs).toBe(1);
      expect(artifacts.artifacts.filter((artifact: { type: string }) => artifact.type === "structured_review")).toHaveLength(3);
      expect(artifacts.artifacts.filter((artifact: { type: string }) => artifact.type === "review_evidence")).toHaveLength(3);
    });
  });
});
