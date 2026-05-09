import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { createCli } from "../src/cli.js";
import { createIntent } from "../src/orchestrator.js";
import { saveJson } from "../src/storage.js";
import { initWorkspace } from "../src/workspace.js";

interface CliResult {
  output: string;
  exitCode: string | number | undefined;
}

async function withWorkspace<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "maw-operator-guidance-test-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runCli(root: string, args: string[]): Promise<CliResult> {
  const lines: string[] = [];
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
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
    return {
      output: lines.length === 0 ? "" : lines.join("\n") + "\n",
      exitCode: process.exitCode
    };
  } finally {
    log.mockRestore();
    error.mockRestore();
    process.exitCode = previousExitCode;
  }
}

const initialTime = "2026-05-08T00:00:00.000Z";
const currentTime = "2026-05-08T00:10:00.000Z";

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
    owner_agent_id: "builder_1",
    owner_role: "Builder Agent",
    executor: "dry_run",
    model_tier: "mid",
    input_context: ["state/prompt_contract.md"],
    output_required: "Delegation packet",
    acceptance_criteria: ["Delegation packet exists"],
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
    agent_id: "builder_1",
    executor: "dry_run",
    model_tier: "mid",
    reason: "Emit a delegation packet.",
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

async function seedPassingPlanCheck(root: string): Promise<void> {
  await saveJson(root, "state/plan_checks.json", {
    plan_checks: [
      {
        check_id: "PC-001",
        deployment_id: "DP-001",
        status: "pass",
        issues: [],
        created_at: currentTime,
        updated_at: currentTime
      }
    ]
  });
}

describe("operator transition guidance", () => {
  test("init prints transition guidance", async () => {
    await withWorkspace(async (root) => {
      const result = await runCli(root, ["init"]);

      expect(result.output).toContain("Initialized multi-agent workflow workspace.");
      expect(result.output).toContain("Workflow State: idle");
      expect(result.output).toContain("Next: maw intent create --text \"Describe the work\"");
    });
  });

  test("intent create prints transition guidance", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);

      const result = await runCli(root, ["intent", "create", "--text", "Build a verified artifact."]);

      expect(result.output).toContain("Created intent I-001.");
      expect(result.output).toContain("Workflow State: planning_needed");
      expect(result.output).toContain("Next: maw orchestrate --intent I-001");
    });
  });

  test("approval record prints transition guidance", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await seedDeployment(root, {
        plan: { status: "proposed", approval_required: true },
        assignments: [{ agent_id: "researcher_1", executor: "model_agent" }],
        tasks: [{ owner_agent_id: "researcher_1", owner_role: "Research Agent", executor: "model_agent" }]
      });
      await seedPassingPlanCheck(root);

      const result = await runCli(root, [
        "approval",
        "record",
        "--deployment",
        "DP-001",
        "--approver",
        "operator",
        "--scope",
        "Run DP-001 after plan-check review."
      ]);

      expect(result.output).toContain("Recorded approval AP-001.");
      expect(result.output).toContain("Workflow State: execution_ready");
      expect(result.output).toContain("Next: maw run --deployment DP-001");
    });
  });

  test("run success prints transition guidance", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await seedDeployment(root, { plan: { status: "approved", approval_required: false } });
      await seedPassingPlanCheck(root);

      const result = await runCli(root, ["run", "--deployment", "DP-001"]);

      expect(result.output).toContain("Completed: T-001");
      expect(result.output).toContain("Workflow State: scoring_needed");
      expect(result.output).toContain("Next: maw score --deployment DP-001");
      expect(result.exitCode).toBeUndefined();
    });
  });

  test("run failure preserves failed exit behavior and prints guidance", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await seedDeployment(root, {
        plan: { status: "approved", approval_required: false },
        tasks: [{ dependencies: ["T-000"] }]
      });
      await seedPassingPlanCheck(root);

      const result = await runCli(root, ["run", "--deployment", "DP-001"]);

      expect(result.output).toContain("Completed: none");
      expect(result.output).toContain("Failed: T-001");
      expect(result.output).toContain("Workflow State: failed");
      expect(result.output).toContain("Next: maw doctor");
      expect(result.exitCode).toBe(1);
    });
  });

  test("plan-check json output remains pure JSON", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await seedDeployment(root, {
        assignments: [{ agent_id: "researcher_1", executor: "model_agent" }],
        tasks: [{ owner_agent_id: "researcher_1", owner_role: "Research Agent", executor: "model_agent" }]
      });

      const result = await runCli(root, ["plan-check", "--deployment", "DP-001", "--json"]);

      expect(JSON.parse(result.output).deployment_id).toBe("DP-001");
      expect(result.output).not.toContain("Workflow State:");
    });
  });

  test("score json output remains pure JSON", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await seedDeployment(root, {
        plan: { status: "completed", approval_required: false },
        tasks: [{ status: "completed", review_required: false }]
      });

      const result = await runCli(root, ["score", "--deployment", "DP-001", "--json"]);

      expect(JSON.parse(result.output).deployment_id).toBe("DP-001");
      expect(result.output).not.toContain("Next:");
    });
  });

  test("next default remains exact", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await seedDeployment(root);

      const result = await runCli(root, ["next"]);

      expect(result.output).toBe("maw plan-check --deployment DP-001\n");
    });
  });

  test("status remains a single state summary", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);

      const result = await runCli(root, ["status"]);

      expect(result.output).toContain("Workflow State: idle");
      expect(result.output.match(/Workflow State:/g)).toHaveLength(1);
    });
  });

  test("doctor remains a diagnostic report", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);

      const result = await runCli(root, ["doctor"]);

      expect(result.output).toContain("Doctor Summary:");
      expect(result.output.match(/Workflow State:/g)).toHaveLength(1);
    });
  });

  test("validate success prints transition guidance", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);

      const result = await runCli(root, ["validate"]);

      expect(result.output).toContain("Workflow state is valid.");
      expect(result.output).toContain("Workflow State: idle");
      expect(result.output).toContain("Next: maw intent create --text \"Describe the work\"");
    });
  });

  test("bootstrap json output remains pure JSON", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);

      const result = await runCli(root, ["bootstrap", "--json"]);

      expect(JSON.parse(result.output).bootstrap_id).toBe("BS-001");
      expect(result.output).not.toContain("Workflow State:");
    });
  });

  test("bootstrap markdown appends transition guidance", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);

      const result = await runCli(root, ["bootstrap"]);

      expect(result.output).toContain("# Bootstrap BS-001");
      expect(result.output).toContain("Workflow State: idle");
      expect(result.output).toContain("Next: maw intent create --text \"Describe the work\"");
    });
  });

  test("human-readable plan-check appends transition guidance", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await seedDeployment(root, {
        assignments: [{ agent_id: "researcher_1", executor: "model_agent" }],
        tasks: [{ owner_agent_id: "researcher_1", owner_role: "Research Agent", executor: "model_agent" }]
      });

      const result = await runCli(root, ["plan-check", "--deployment", "DP-001"]);

      expect(result.output).toContain("Plan Check PC-001:");
      expect(result.output).toContain("Workflow State:");
      expect(result.output).toContain("Next:");
    });
  });

  test("human-readable score appends transition guidance", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await seedDeployment(root, {
        plan: { status: "completed", approval_required: false },
        tasks: [{ status: "completed", review_required: false }]
      });

      const result = await runCli(root, ["score", "--deployment", "DP-001"]);

      expect(result.output).toContain("Workflow Score WS-001");
      expect(result.output).toContain("Workflow State: retrospective_needed");
      expect(result.output).toContain("Next: maw retrospective --deployment DP-001");
    });
  });

  test("created intent guidance uses current operator state", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await createIntent(root, { text: "Existing planned work." });

      const result = await runCli(root, ["intent", "create", "--text", "Second item."]);

      expect(result.output).toContain("Created intent I-002.");
      expect(result.output).toContain("Next: maw orchestrate --intent I-002");
    });
  });
});
