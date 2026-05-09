import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { createCli } from "../src/cli.js";
import { saveJson } from "../src/storage.js";
import { initWorkspace } from "../src/workspace.js";

async function withWorkspace<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "maw-operator-commands-test-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runCli(root: string, args: string[]): Promise<string> {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((message?: unknown, ...rest: unknown[]) => {
    lines.push([message, ...rest].map((entry) => String(entry)).join(" "));
  });
  const error = vi.spyOn(console, "error").mockImplementation((message?: unknown, ...rest: unknown[]) => {
    lines.push([message, ...rest].map((entry) => String(entry)).join(" "));
  });
  const program = createCli(root);
  program.exitOverride();
  program.configureOutput({
    writeOut: (value) => lines.push(value.endsWith("\n") ? value.slice(0, -1) : value),
    writeErr: (value) => lines.push(value.endsWith("\n") ? value.slice(0, -1) : value)
  });
  try {
    await program.parseAsync(["node", "maw", ...args], { from: "node" });
  } finally {
    log.mockRestore();
    error.mockRestore();
    process.exitCode = undefined;
  }
  return lines.length === 0 ? "" : lines.join("\n") + "\n";
}

const initialTime = "2026-05-08T00:00:00.000Z";
const currentTime = "2026-05-08T00:10:00.000Z";
const laterTime = "2026-05-08T00:20:00.000Z";

function intent(overrides: Record<string, unknown> = {}) {
  return {
    intent_id: "I-001",
    text: "Build a verified artifact.",
    constraints: [],
    risk_level: "medium",
    status: "planned",
    created_at: initialTime,
    updated_at: currentTime,
    ...overrides
  };
}

function task(overrides: Record<string, unknown> = {}) {
  return {
    task_id: "T-001",
    title: "Produce deliverable",
    owner_agent_id: "researcher_1",
    owner_role: "Research Agent",
    executor: "model_agent",
    model_tier: "mid",
    input_context: ["state/prompt_contract.md"],
    output_required: "A complete deliverable",
    acceptance_criteria: ["Specific, measurable criterion"],
    dependencies: [],
    risk_level: "medium",
    review_required: false,
    approval_required: false,
    status: "queued",
    artifacts: [],
    deployment_id: "DP-001",
    created_at: initialTime,
    updated_at: currentTime,
    ...overrides
  };
}

function assignment(overrides: Record<string, unknown> = {}) {
  return {
    task_id: "T-001",
    agent_id: "researcher_1",
    executor: "model_agent",
    model_tier: "mid",
    reason: "Produce the deliverable.",
    approval_required: false,
    ...overrides
  };
}

function deployment(overrides: Record<string, unknown> = {}) {
  return {
    deployment_id: "DP-001",
    intent_id: "I-001",
    status: "proposed",
    approval_required: true,
    assignments: [assignment()],
    created_at: initialTime,
    updated_at: currentTime,
    ...overrides
  };
}

async function seedDeployment(
  root: string,
  input: {
    plan?: Record<string, unknown>;
    tasks?: Array<Record<string, unknown>>;
    assignments?: Array<Record<string, unknown>>;
  } = {}
): Promise<void> {
  const assignments = input.assignments?.map((entry) => assignment(entry)) ?? [assignment()];
  await saveJson(root, "state/intent_queue.json", { intents: [intent()] });
  await saveJson(root, "state/task_board.json", {
    tasks: (input.tasks ?? [{}]).map((entry) => task(entry))
  });
  await saveJson(root, "state/deployment_plan.json", {
    deployment_plans: [
      deployment({
        assignments,
        ...input.plan
      })
    ]
  });
}

async function seedPassingConsensus(root: string): Promise<void> {
  await saveJson(root, "state/consensus.json", {
    consensus_records: [
      {
        consensus_id: "C-001",
        task_id: "T-001",
        review_ids: ["R-001"],
        reviewer_count: 1,
        per_criterion: [
          {
            criterion: "Specific, measurable criterion",
            pass_count: 1,
            fail_count: 0,
            unverifiable_count: 0,
            abstain_count: 0,
            verdict: "pass",
            convergent_citations: [{ artifact_id: "ART-001", line_start: 1, line_end: 1 }],
            dissent: []
          }
        ],
        overall_verdict: "pass",
        is_load_bearing: true,
        created_at: laterTime,
        updated_at: laterTime
      }
    ]
  });
}

async function seedScore(root: string): Promise<void> {
  await saveJson(root, "state/workflow_score.json", {
    workflow_scores: [
      {
        score_id: "WS-001",
        deployment_id: "DP-001",
        verified_useful_outputs: 1,
        consensus_pass_count: 1,
        consensus_split_count: 0,
        consensus_insufficient_count: 0,
        review_pass_rate: 1,
        failed_tasks: 0,
        rerun_count: 0,
        human_interventions: 1,
        context_failures: 0,
        model_calls: 1,
        dry_runs: 0,
        workflow_intelligence_yield: 0.5,
        created_at: laterTime,
        updated_at: laterTime
      }
    ]
  });
}

async function seedRetrospective(root: string): Promise<void> {
  await saveJson(root, "state/retrospective_index.json", {
    retrospectives: [
      {
        retrospective_id: "RET-001",
        deployment_id: "DP-001",
        path: "state/retrospectives/RET-001.md",
        created_at: laterTime,
        updated_at: laterTime
      }
    ]
  });
}

async function seedPerformance(root: string): Promise<void> {
  await saveJson(root, "state/performance_ledger.json", {
    entries: [
      {
        deployment_id: "DP-001",
        agent_id: "researcher_1",
        tasks_assigned: 1,
        tasks_completed: 1,
        tasks_failed: 0,
        review_passes: 1,
        review_failures: 0,
        dry_run_deliverable_mismatches: 0,
        known_failure_modes: [],
        updated_at: laterTime
      }
    ]
  });
}

async function seedCompleteWorkflow(root: string): Promise<void> {
  await seedDeployment(root, {
    plan: { status: "completed", updated_at: laterTime },
    tasks: [{ status: "completed", review_required: true, updated_at: laterTime }]
  });
  await saveJson(root, "state/approvals.json", {
    approvals: [
      {
        approval_id: "AP-001",
        deployment_id: "DP-001",
        approver: "operator",
        decision: "approved",
        scope: "Run DP-001 after plan-check review.",
        created_at: currentTime
      }
    ]
  });
  await seedPassingConsensus(root);
  await seedScore(root);
  await seedRetrospective(root);
  await seedPerformance(root);
}

describe("operator navigation commands", () => {
  test("status on uninitialized workspace orients without creating files", async () => {
    await withWorkspace(async (root) => {
      const output = await runCli(root, ["status"]);

      expect(output).toContain("Workflow State: uninitialized");
      expect(output).toContain("Next: maw init");
      expect(await readdir(root)).toEqual([]);
    });
  });

  test("next on uninitialized workspace prints only the command", async () => {
    await withWorkspace(async (root) => {
      await expect(runCli(root, ["next"])).resolves.toBe("maw init\n");
    });
  });

  test("next reason on idle workspace prints command and reason", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);

      const output = await runCli(root, ["next", "--reason"]);

      expect(output).toContain("maw intent create --text \"Describe the work\"\n");
      expect(output).toContain("Reason: no active intent exists.");
    });
  });

  test("status on idle workspace renders no active objects", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);

      const output = await runCli(root, ["status"]);

      expect(output).toContain("Workflow State: idle");
      expect(output).toContain("Active Intent: none");
      expect(output).toContain("Active Deployment: none");
      expect(output).toContain("Active Task: none");
      expect(output).toContain("Next: maw intent create --text \"Describe the work\"");
    });
  });

  test("status on proposed deployment shows plan-check guidance", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await seedDeployment(root);

      const output = await runCli(root, ["status"]);

      expect(output).toContain("Active Deployment: DP-001");
      expect(output).toContain("PLAN_CHECK_MISSING");
      expect(output).toContain("Next: maw plan-check --deployment DP-001");
    });
  });

  test("next on proposed deployment prints only plan-check command", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await seedDeployment(root);

      await expect(runCli(root, ["next"])).resolves.toBe("maw plan-check --deployment DP-001\n");
    });
  });

  test("doctor on malformed state reports invalid state without repair", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await writeFile(join(root, "state/intent_queue.json"), "{", "utf8");

      const output = await runCli(root, ["doctor"]);
      const malformed = await readFile(join(root, "state/intent_queue.json"), "utf8");

      expect(output).toContain("Doctor Summary: issues_found");
      expect(output).toContain("STATE_FILE_INVALID");
      expect(output).toContain("State Safety: no production command was run; state was not modified.");
      expect(malformed).toBe("{");
    });
  });

  test("doctor reports missing configured model API key", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const previous = process.env.MAW_TEST_OPERATOR_COMMANDS_KEY;
      delete process.env.MAW_TEST_OPERATOR_COMMANDS_KEY;
      await saveJson(root, "state/model_config.json", {
        provider: "openai",
        base_url: "https://api.openai.com/v1",
        api_key_env: "MAW_TEST_OPERATOR_COMMANDS_KEY",
        default_models: {
          orchestrator: "gpt-5.2",
          high: "gpt-5.2",
          mid: "gpt-5-mini",
          low: "gpt-5-nano"
        }
      });
      try {
        const output = await runCli(root, ["doctor"]);

        expect(output).toContain("MODEL_API_KEY_MISSING");
        expect(output).toContain("Repair: set environment variable MAW_TEST_OPERATOR_COMMANDS_KEY before model-backed commands.");
      } finally {
        if (previous === undefined) delete process.env.MAW_TEST_OPERATOR_COMMANDS_KEY;
        else process.env.MAW_TEST_OPERATOR_COMMANDS_KEY = previous;
      }
    });
  });

  test("doctor reports high-risk reviewer shortage", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await seedDeployment(root, {
        plan: { status: "approved", approved_at: currentTime },
        tasks: [{ risk_level: "high", review_required: true }]
      });
      await saveJson(root, "state/agent_registry.json", {
        agents: [
          {
            agent_id: "researcher_1",
            role: "Research Agent",
            executor_type: "model_agent",
            model_tier: "mid",
            allowed_tools: [],
            command_allowlist: [],
            permissions: {
              external_actions: false,
              destructive_actions: false,
              credential_access: false,
              paid_actions: false,
              public_actions: false
            },
            max_cost_usd: 1
          },
          {
            agent_id: "reviewer_skeptical",
            role: "Reviewer Agent",
            executor_type: "model_agent",
            model_tier: "high",
            reviewer_persona: "skeptical",
            allowed_tools: [],
            command_allowlist: [],
            permissions: {
              external_actions: false,
              destructive_actions: false,
              credential_access: false,
              paid_actions: false,
              public_actions: false
            },
            max_cost_usd: 1
          }
        ]
      });

      const output = await runCli(root, ["doctor"]);

      expect(output).toContain("REVIEWER_COVERAGE_INSUFFICIENT");
      expect(output).toContain("Repair: register or restore Reviewer agents with distinct reviewer_persona values.");
    });
  });

  test("doctor reports local command not allowlisted", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await seedDeployment(root, {
        plan: { status: "approved", approved_at: currentTime },
        assignments: [{ agent_id: "shell_1", executor: "local_command" }],
        tasks: [
          {
            owner_agent_id: "shell_1",
            owner_role: "Shell Agent",
            executor: "local_command",
            command: { command: "node", args: ["--version"] }
          }
        ]
      });
      await saveJson(root, "state/agent_registry.json", {
        agents: [
          {
            agent_id: "shell_1",
            role: "Shell Agent",
            executor_type: "local_command",
            model_tier: "low",
            allowed_tools: [],
            command_allowlist: [],
            permissions: {
              external_actions: false,
              destructive_actions: false,
              credential_access: false,
              paid_actions: false,
              public_actions: false
            },
            max_cost_usd: 0
          }
        ]
      });

      const output = await runCli(root, ["doctor"]);

      expect(output).toContain("LOCAL_COMMAND_NOT_ALLOWLISTED");
      expect(output).toContain("Repair: add the command to the assigned agent allowlist or reroute the task.");
    });
  });

  test("doctor does not report execute requirement for completed local-command deployment", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const previous = process.env.MAW_TEST_OPERATOR_COMMANDS_COMPLETE_LOCAL_KEY;
      process.env.MAW_TEST_OPERATOR_COMMANDS_COMPLETE_LOCAL_KEY = "present";
      await saveJson(root, "state/model_config.json", {
        provider: "openai",
        base_url: "https://api.openai.com/v1",
        api_key_env: "MAW_TEST_OPERATOR_COMMANDS_COMPLETE_LOCAL_KEY",
        default_models: {
          orchestrator: "gpt-5.2",
          high: "gpt-5.2",
          mid: "gpt-5-mini",
          low: "gpt-5-nano"
        }
      });
      await seedDeployment(root, {
        plan: { status: "completed", updated_at: laterTime },
        assignments: [{ agent_id: "shell_1", executor: "local_command" }],
        tasks: [
          {
            owner_agent_id: "shell_1",
            owner_role: "Shell Agent",
            executor: "local_command",
            status: "completed",
            review_required: false,
            command: { command: "node", args: ["--version"] },
            updated_at: laterTime
          }
        ]
      });
      await saveJson(root, "state/agent_registry.json", {
        agents: [
          {
            agent_id: "shell_1",
            role: "Shell Agent",
            executor_type: "local_command",
            model_tier: "low",
            allowed_tools: [],
            command_allowlist: ["node"],
            permissions: {
              external_actions: false,
              destructive_actions: false,
              credential_access: false,
              paid_actions: false,
              public_actions: false
            },
            max_cost_usd: 0
          }
        ]
      });
      await saveJson(root, "state/approvals.json", {
        approvals: [
          {
            approval_id: "AP-001",
            deployment_id: "DP-001",
            approver: "operator",
            decision: "approved",
            scope: "Run DP-001 after plan-check review.",
            created_at: currentTime
          }
        ]
      });
      await seedScore(root);
      await seedRetrospective(root);
      await seedPerformance(root);
      try {
        const output = await runCli(root, ["doctor"]);

        expect(output).toContain("Doctor Summary: no_issues_found");
        expect(output).not.toContain("LOCAL_COMMAND_REQUIRES_EXECUTE");
      } finally {
        if (previous === undefined) delete process.env.MAW_TEST_OPERATOR_COMMANDS_COMPLETE_LOCAL_KEY;
        else process.env.MAW_TEST_OPERATOR_COMMANDS_COMPLETE_LOCAL_KEY = previous;
      }
    });
  });

  test("doctor on failed task and chat blocker includes repair guidance", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await seedDeployment(root, {
        plan: { status: "failed" },
        tasks: [{ status: "failed", blocker: "quota exhausted" }]
      });
      await saveJson(root, "state/chat.json", {
        messages: [
          {
            message_id: "M-001",
            timestamp: currentTime,
            from_agent: "runner",
            to: "orchestrator",
            type: "blocker",
            task_id: "T-001",
            summary: "quota exhausted",
            details: "quota exhausted",
            requires_action: true,
            recommended_next_step: "Fix quota and rerun."
          }
        ]
      });

      const output = await runCli(root, ["doctor"]);

      expect(output).toContain("TASK_FAILED");
      expect(output).toContain("Repair: inspect task blocker, fix the cause, then run maw run --deployment DP-001 --rerun.");
      expect(output).toContain("CHAT_REQUIRES_ACTION");
      expect(output).toContain("Repair: follow the recorded next step: Fix quota and rerun.");
      expect(output).toContain("Next: maw doctor");
      expect(output).toContain("Reason: active blockers or failed tasks require diagnosis before continuing.");
    });
  });

  test("doctor on complete workflow reports no issues and recommends report", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const previous = process.env.MAW_TEST_OPERATOR_COMMANDS_COMPLETE_KEY;
      process.env.MAW_TEST_OPERATOR_COMMANDS_COMPLETE_KEY = "present";
      await saveJson(root, "state/model_config.json", {
        provider: "openai",
        base_url: "https://api.openai.com/v1",
        api_key_env: "MAW_TEST_OPERATOR_COMMANDS_COMPLETE_KEY",
        default_models: {
          orchestrator: "gpt-5.2",
          high: "gpt-5.2",
          mid: "gpt-5-mini",
          low: "gpt-5-nano"
        }
      });
      await seedCompleteWorkflow(root);
      try {
        const output = await runCli(root, ["doctor"]);

        expect(output).toContain("Doctor Summary: no_issues_found");
        expect(output).toContain("Findings:\n- none");
        expect(output).toContain("Next: maw report");
      } finally {
        if (previous === undefined) delete process.env.MAW_TEST_OPERATOR_COMMANDS_COMPLETE_KEY;
        else process.env.MAW_TEST_OPERATOR_COMMANDS_COMPLETE_KEY = previous;
      }
    });
  });
});

describe("intent text input forms", () => {
  test("intent create --text-file reads text from a file", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const path = join(root, "intent.txt");
      await writeFile(
        path,
        'Build a tool that supports "deep search" mode and returns a "ranked list".',
        "utf8"
      );

      const output = await runCli(root, ["intent", "create", "--text-file", path]);

      expect(output).toContain("Created intent I-001.");
      const queue = JSON.parse(
        await readFile(join(root, "state/intent_queue.json"), "utf8")
      );
      expect(queue.intents[0].text).toContain('"deep search"');
      expect(queue.intents[0].text).toContain('"ranked list"');
    });
  });

  test("intent create rejects --text and --text-file together", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const path = join(root, "intent.txt");
      await writeFile(path, "from file", "utf8");

      await expect(
        runCli(root, ["intent", "create", "--text", "from flag", "--text-file", path])
      ).rejects.toThrow(/Pass either --text or --text-file, not both/);

      const queue = JSON.parse(
        await readFile(join(root, "state/intent_queue.json"), "utf8")
      );
      expect(queue.intents).toEqual([]);
    });
  });

  test("intent create rejects when neither --text nor --text-file is supplied", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);

      await expect(runCli(root, ["intent", "create"])).rejects.toThrow(
        /Either --text or --text-file is required/
      );

      const queue = JSON.parse(
        await readFile(join(root, "state/intent_queue.json"), "utf8")
      );
      expect(queue.intents).toEqual([]);
    });
  });

  test("intent create --text-file rejects when the file is missing", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const missing = join(root, "does-not-exist.txt");

      await expect(
        runCli(root, ["intent", "create", "--text-file", missing])
      ).rejects.toThrow(/Could not read --text-file/);

      const queue = JSON.parse(
        await readFile(join(root, "state/intent_queue.json"), "utf8")
      );
      expect(queue.intents).toEqual([]);
    });
  });

  test("intent create --text-file rejects whitespace-only file content", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const path = join(root, "blank.txt");
      await writeFile(path, "   \n\n\t  ", "utf8");

      await expect(
        runCli(root, ["intent", "create", "--text-file", path])
      ).rejects.toThrow(/Intent text must be non-empty/);

      const queue = JSON.parse(
        await readFile(join(root, "state/intent_queue.json"), "utf8")
      );
      expect(queue.intents).toEqual([]);
    });
  });
});

describe("implicit active-context defaults", () => {
  test("plan-check without --deployment uses active deployment", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await seedDeployment(root, {
        assignments: [{ agent_id: "researcher_1", executor: "model_agent" }],
        tasks: [
          { owner_agent_id: "researcher_1", owner_role: "Research Agent", executor: "model_agent" }
        ]
      });

      const explicit = await runCli(root, ["plan-check", "--deployment", "DP-001"]);
      const implicit = await runCli(root, ["plan-check"]);

      expect(explicit).toContain("Plan Check");
      expect(implicit).toContain("Plan Check");
    });
  });

  test("approval record without --deployment uses active deployment", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await seedDeployment(root, {
        assignments: [{ agent_id: "researcher_1", executor: "model_agent" }],
        tasks: [
          { owner_agent_id: "researcher_1", owner_role: "Research Agent", executor: "model_agent" }
        ]
      });
      await runCli(root, ["plan-check"]);

      const output = await runCli(root, [
        "approval",
        "record",
        "--approver",
        "operator",
        "--scope",
        "Run DP-001 after plan-check review."
      ]);

      expect(output).toContain("Recorded approval AP-001.");
    });
  });

  test("score without --deployment uses active deployment", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await seedDeployment(root, {
        plan: { status: "completed" },
        tasks: [{ status: "completed", review_required: false }]
      });

      const output = await runCli(root, ["score"]);

      expect(output).toContain("Workflow Score WS-001");
    });
  });

  test("plan-check without --deployment and no active deployment surfaces a recoverable error", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        await expect(runCli(root, ["plan-check"])).rejects.toThrow(/No active deployment/);
      } finally {
        errSpy.mockRestore();
      }
    });
  });
});
