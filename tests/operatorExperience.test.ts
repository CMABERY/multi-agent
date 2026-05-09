import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  classifyOperatorCommand,
  defaultOperatorExperience,
  deriveOperatorMetrics,
  readOperatorExperience,
  recordOperatorEvent,
  renderOperatorExperienceReport
} from "../src/operatorExperience.js";
import { runOperatorCli } from "../src/operatorEntrypoint.js";
import { OperatorExperienceSchema, type OperatorExperience } from "../src/schemas.js";
import { saveJson } from "../src/storage.js";
import { initWorkspace } from "../src/workspace.js";

interface CliResult {
  output: string;
  exitCode: number | string | undefined;
}

async function withWorkspace<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "maw-operator-experience-test-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runCli(root: string, args: string[]): Promise<CliResult> {
  const lines: string[] = [];
  const previous = process.exitCode;
  process.exitCode = undefined;
  const log = vi.spyOn(console, "log").mockImplementation((message?: unknown, ...rest: unknown[]) => {
    lines.push([message, ...rest].map((entry) => String(entry)).join(" "));
  });
  const errSpy = vi.spyOn(console, "error").mockImplementation((message?: unknown, ...rest: unknown[]) => {
    lines.push([message, ...rest].map((entry) => String(entry)).join(" "));
  });
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((value: any) => {
    const str = typeof value === "string" ? value : String(value);
    lines.push(str.endsWith("\n") ? str.slice(0, -1) : str);
    return true;
  });
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation((value: any) => {
    const str = typeof value === "string" ? value : String(value);
    lines.push(str.endsWith("\n") ? str.slice(0, -1) : str);
    return true;
  });
  try {
    await runOperatorCli(["node", "maw", ...args], root);
  } finally {
    log.mockRestore();
    errSpy.mockRestore();
    stdout.mockRestore();
    stderr.mockRestore();
  }
  const exitCode = process.exitCode;
  process.exitCode = previous;
  return {
    output: lines.length === 0 ? "" : lines.join("\n") + "\n",
    exitCode
  };
}

async function readExperience(root: string): Promise<OperatorExperience> {
  const raw = await readFile(join(root, "state/operator_experience.json"), "utf8");
  return OperatorExperienceSchema.parse(JSON.parse(raw));
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

async function seedCompleteWorkflow(root: string): Promise<void> {
  await seedDeployment(root, {
    plan: { status: "completed", updated_at: laterTime, approval_required: true },
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
  await saveJson(root, "state/consensus.json", {
    consensus_records: [
      {
        consensus_id: "C-001",
        task_id: "T-001",
        review_ids: ["R-001"],
        reviewer_count: 1,
        per_criterion: [
          {
            criterion: "Delegation packet exists",
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
  await saveJson(root, "state/performance_ledger.json", {
    entries: [
      {
        deployment_id: "DP-001",
        agent_id: "builder_1",
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

describe("classifyOperatorCommand", () => {
  test("recognizes single and grouped commands", () => {
    expect(classifyOperatorCommand(["node", "maw", "init"]).family).toBe("init");
    expect(classifyOperatorCommand(["node", "maw", "intent", "create", "--text", "x"]).family).toBe(
      "intent create"
    );
    expect(classifyOperatorCommand(["node", "maw", "scaffold", "agent", "--id", "a"]).family).toBe(
      "scaffold agent"
    );
    expect(classifyOperatorCommand(["node", "maw", "operator", "metrics"]).family).toBe(
      "operator metrics"
    );
  });

  test("flags JSON outputs as next-step not applicable", () => {
    const c = classifyOperatorCommand(["node", "maw", "plan-check", "--deployment", "DP-001", "--json"]);
    expect(c.nextStepApplicable).toBe(false);
  });

  test("flags report and operator metrics as next-step not applicable", () => {
    expect(classifyOperatorCommand(["node", "maw", "report"]).nextStepApplicable).toBe(false);
    expect(classifyOperatorCommand(["node", "maw", "operator", "metrics"]).nextStepApplicable).toBe(false);
  });

  test("flags scaffold subcommands as extensions", () => {
    expect(classifyOperatorCommand(["node", "maw", "scaffold", "agent"]).isExtension).toBe(true);
    expect(classifyOperatorCommand(["node", "maw", "scaffold", "command"]).isExtension).toBe(true);
    expect(classifyOperatorCommand(["node", "maw", "intent", "create"]).isExtension).toBe(false);
  });

  test("metrics command is marked skipRecording", () => {
    expect(classifyOperatorCommand(["node", "maw", "operator", "metrics"]).skipRecording).toBe(true);
    expect(classifyOperatorCommand(["node", "maw", "init"]).skipRecording).toBe(false);
  });

  test("unknown top-level commands normalize to unknown", () => {
    expect(classifyOperatorCommand(["node", "maw", "sk-secret-value"]).family).toBe("unknown");
    expect(classifyOperatorCommand(["node", "maw", "rm", "-rf", "/"]).family).toBe("unknown");
    expect(classifyOperatorCommand(["node", "maw", "OPENAI_API_KEY=abc"]).family).toBe("unknown");
  });

  test("grouped typos normalize to unknown", () => {
    expect(classifyOperatorCommand(["node", "maw", "scaffold", "sk-secret-value"]).family).toBe(
      "unknown"
    );
    expect(classifyOperatorCommand(["node", "maw", "intent", "destroy"]).family).toBe("unknown");
    expect(classifyOperatorCommand(["node", "maw", "operator", "exfiltrate"]).family).toBe("unknown");
  });
});

describe("operator experience CLI integration", () => {
  test("init records a successful init event and creates the metrics file", async () => {
    await withWorkspace(async (root) => {
      const result = await runCli(root, ["init"]);
      expect(result.exitCode).toBeUndefined();
      const experience = await readExperience(root);
      expect(experience.events).toHaveLength(1);
      const event = experience.events[0];
      expect(event?.command).toBe("init");
      expect(event?.outcome).toBe("success");
      expect(event?.next_step_applicable).toBe(true);
      expect(event?.next_step_present).toBe(true);
    });
  });

  test("intent create records success with next-step applicable and present", async () => {
    await withWorkspace(async (root) => {
      await runCli(root, ["init"]);
      await runCli(root, ["intent", "create", "--text", "Build a verified artifact."]);
      const experience = await readExperience(root);
      const event = experience.events.find((entry) => entry.command === "intent create");
      expect(event).toBeDefined();
      expect(event?.outcome).toBe("success");
      expect(event?.next_step_applicable).toBe(true);
      expect(event?.next_step_present).toBe(true);
    });
  });

  test("report and JSON outputs record next-step not applicable", async () => {
    await withWorkspace(async (root) => {
      await runCli(root, ["init"]);
      await runCli(root, ["report"]);
      await runCli(root, ["bootstrap", "--json"]);
      const experience = await readExperience(root);
      const reportEvent = experience.events.find((entry) => entry.command === "report");
      const bootstrapEvent = experience.events.find((entry) => entry.command === "bootstrap");
      expect(reportEvent?.next_step_applicable).toBe(false);
      expect(reportEvent?.next_step_present).toBe(false);
      expect(bootstrapEvent?.next_step_applicable).toBe(false);
      expect(bootstrapEvent?.next_step_present).toBe(false);
    });
  });

  test("operator metrics renders all labels and does not record itself", async () => {
    await withWorkspace(async (root) => {
      await runCli(root, ["init"]);
      const before = await readExperience(root);
      const result = await runCli(root, ["operator", "metrics"]);
      expect(result.output).toContain("Operator Experience Metrics");
      expect(result.output).toContain("Command Attempts:");
      expect(result.output).toContain("Next-Step Coverage:");
      expect(result.output).toContain("Invalid Command Rate:");
      expect(result.output).toContain("Help Invocation Rate:");
      expect(result.output).toContain("Successful Error Recovery Rate:");
      expect(result.output).toContain("Extension Success Rate:");
      expect(result.output).toContain("Time To First Successful Workflow:");
      expect(result.output).toContain("Commands Before Successful Deployment:");
      const after = await readExperience(root);
      expect(after.events.length).toBe(before.events.length);
    });
  });

  test("invalid command records an invalid event with nonzero exit", async () => {
    await withWorkspace(async (root) => {
      await runCli(root, ["init"]);
      const result = await runCli(root, ["nonsense-command"]);
      expect(result.exitCode).toBe(1);
      const experience = await readExperience(root);
      const invalid = experience.events.find((entry) => entry.outcome === "invalid");
      expect(invalid).toBeDefined();
      expect(invalid?.next_step_applicable).toBe(false);
      expect(invalid?.next_step_present).toBe(false);
    });
  });

  test("invalid commands do not distort next-step coverage in the metrics report", async () => {
    await withWorkspace(async (root) => {
      await runCli(root, ["init"]);
      await runCli(root, ["nonsense-command"]);
      const result = await runCli(root, ["operator", "metrics"]);
      expect(result.output).toContain("Next-Step Coverage: 1/1 (1.000)");
      expect(result.output).toContain("Invalid Command Rate: 1/2 (0.500)");
    });
  });

  test("unknown top-level command persists as unknown, not the raw token", async () => {
    await withWorkspace(async (root) => {
      await runCli(root, ["init"]);
      const result = await runCli(root, ["sk-secret-value"]);
      expect(result.exitCode).toBe(1);
      const experience = await readExperience(root);
      const invalid = experience.events.find((entry) => entry.outcome === "invalid");
      expect(invalid).toBeDefined();
      expect(invalid?.command).toBe("unknown");
      const persisted = await readFile(join(root, "state/operator_experience.json"), "utf8");
      expect(persisted).not.toContain("sk-secret-value");
    });
  });

  test("grouped typo persists as unknown, not the raw subcommand token", async () => {
    await withWorkspace(async (root) => {
      await runCli(root, ["init"]);
      const result = await runCli(root, ["scaffold", "sk-secret-value"]);
      expect(result.exitCode).toBe(1);
      const experience = await readExperience(root);
      const invalid = experience.events.find((entry) => entry.outcome === "invalid");
      expect(invalid).toBeDefined();
      expect(invalid?.command).toBe("unknown");
      const persisted = await readFile(join(root, "state/operator_experience.json"), "utf8");
      expect(persisted).not.toContain("sk-secret-value");
    });
  });

  test("help records a help event and preserves help output", async () => {
    await withWorkspace(async (root) => {
      await runCli(root, ["init"]);
      const result = await runCli(root, ["--help"]);
      expect(result.output).toContain("Usage:");
      const experience = await readExperience(root);
      const help = experience.events.find((entry) => entry.outcome === "help");
      expect(help).toBeDefined();
    });
  });

  test("recoverable approval failure records recoverable_error and pending recovery", async () => {
    await withWorkspace(async (root) => {
      await runCli(root, ["init"]);
      await seedDeployment(root, { plan: { status: "approved", approval_required: true } });
      const result = await runCli(root, ["run", "--deployment", "DP-001"]);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("Corrective Command:");
      const experience = await readExperience(root);
      const event = experience.events.find((entry) => entry.recoverable_error);
      expect(event).toBeDefined();
      expect(event?.command).toBe("run");
      expect(experience.pending_recovery).not.toBeNull();
      expect(experience.pending_recovery?.corrective_family).toBe("plan-check");
      expect(experience.pending_recovery?.next_family).toBe("approval record");
    });
  });

  test("subsequent corrective command records recovery_success and clears pending recovery", async () => {
    await withWorkspace(async (root) => {
      await runCli(root, ["init"]);
      await seedDeployment(root, { plan: { status: "approved", approval_required: true } });
      await runCli(root, ["run", "--deployment", "DP-001"]);
      const before = await readExperience(root);
      expect(before.pending_recovery).not.toBeNull();
      await runCli(root, ["plan-check", "--deployment", "DP-001"]);
      const after = await readExperience(root);
      const last = after.events[after.events.length - 1];
      expect(last?.command).toBe("plan-check");
      expect(last?.recovery_success).toBe(true);
      expect(after.pending_recovery).toBeNull();
    });
  });

  test("scaffold success records an extension success event", async () => {
    await withWorkspace(async (root) => {
      await runCli(root, ["init"]);
      await runCli(root, [
        "scaffold",
        "reviewer",
        "--id",
        "reviewer_test",
        "--persona",
        "adversarial"
      ]);
      const experience = await readExperience(root);
      const event = experience.events.find((entry) => entry.extension_command);
      expect(event).toBeDefined();
      expect(event?.outcome).toBe("success");
      expect(event?.command).toBe("scaffold reviewer");
    });
  });

  test("scaffold validation failure records an extension failure event", async () => {
    await withWorkspace(async (root) => {
      await runCli(root, ["init"]);
      const result = await runCli(root, ["scaffold", "protocol", "--name", "../escape"]);
      expect(result.exitCode).toBe(1);
      const experience = await readExperience(root);
      const event = experience.events.find(
        (entry) => entry.extension_command && entry.outcome === "failure"
      );
      expect(event).toBeDefined();
      expect(event?.command).toBe("scaffold protocol");
    });
  });

  test("first successful run records first_successful_deployment_at and command counts", async () => {
    await withWorkspace(async (root) => {
      await runCli(root, ["init"]);
      await runCli(root, ["intent", "create", "--text", "Build a verified artifact."]);
      await seedDeployment(root, { plan: { status: "approved", approval_required: false } });
      await runCli(root, ["run", "--deployment", "DP-001"]);
      const experience = await readExperience(root);
      expect(experience.first_successful_deployment_at).not.toBeNull();
      const metrics = deriveOperatorMetrics(experience);
      expect(metrics.commands_before_successful_deployment).toBeGreaterThanOrEqual(2);
    });
  });

  test("complete workflow state records first_complete_workflow_at", async () => {
    await withWorkspace(async (root) => {
      await runCli(root, ["init"]);
      await seedCompleteWorkflow(root);
      await runCli(root, ["status"]);
      const experience = await readExperience(root);
      expect(experience.first_complete_workflow_at).not.toBeNull();
    });
  });
});

describe("operator experience pre-init guard", () => {
  async function pathExists(target: string): Promise<boolean> {
    try {
      await access(target);
      return true;
    } catch {
      return false;
    }
  }

  test("uninitialized --help does not create state/ or metrics file", async () => {
    await withWorkspace(async (root) => {
      const result = await runCli(root, ["--help"]);
      expect(result.output).toContain("Usage:");
      expect(await pathExists(join(root, "state"))).toBe(false);
      expect(await pathExists(join(root, "state", "operator_experience.json"))).toBe(false);
    });
  });

  test("uninitialized invalid command does not create state/ or metrics file", async () => {
    await withWorkspace(async (root) => {
      const result = await runCli(root, ["nonsense-command"]);
      expect(result.exitCode).toBe(1);
      expect(await pathExists(join(root, "state"))).toBe(false);
      expect(await pathExists(join(root, "state", "operator_experience.json"))).toBe(false);
    });
  });

  test("initialized --help still records a help event", async () => {
    await withWorkspace(async (root) => {
      await runCli(root, ["init"]);
      const before = await readExperience(root);
      await runCli(root, ["--help"]);
      const after = await readExperience(root);
      expect(after.events.length).toBe(before.events.length + 1);
      const help = after.events[after.events.length - 1];
      expect(help?.outcome).toBe("help");
    });
  });

  test("initialized invalid command still records an invalid event", async () => {
    await withWorkspace(async (root) => {
      await runCli(root, ["init"]);
      const before = await readExperience(root);
      const result = await runCli(root, ["nonsense-command"]);
      expect(result.exitCode).toBe(1);
      const after = await readExperience(root);
      expect(after.events.length).toBe(before.events.length + 1);
      const invalid = after.events[after.events.length - 1];
      expect(invalid?.outcome).toBe("invalid");
    });
  });
});

describe("operator experience module hygiene", () => {
  test("module sources do not import openai or model code", async () => {
    const sources = ["src/operatorExperience.ts", "src/operatorEntrypoint.ts"];
    for (const path of sources) {
      const content = await readFile(join(process.cwd(), path), "utf8");
      expect(content).not.toMatch(/from ["']openai/);
      expect(content).not.toMatch(/from ["']\.\/openai/);
      expect(content).not.toMatch(/validateWorkspace/);
      expect(content).not.toMatch(/runBootstrap/);
      expect(content).not.toMatch(/from ["']https?:/);
      expect(content).not.toMatch(/fetch\(/);
    }
  });
});

describe("operator experience event log capping", () => {
  test("event log caps at 500 events and preserves first-success timestamps", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const baseline = await readExperience(root);
      const fixedTime = "2026-05-08T00:00:00.000Z";
      baseline.first_successful_deployment_at = "2026-05-08T01:00:00.000Z";
      baseline.first_complete_workflow_at = "2026-05-08T02:00:00.000Z";
      baseline.events = [];
      for (let i = 0; i < 600; i++) {
        baseline.events.push({
          event_id: "OX-" + String(i + 1).padStart(3, "0"),
          created_at: fixedTime,
          command: "status",
          outcome: "success",
          next_step_applicable: false,
          next_step_present: false,
          recoverable_error: false,
          recovery_success: false,
          extension_command: false
        });
      }
      await saveJson(root, "state/operator_experience.json", baseline);

      await recordOperatorEvent(root, {
        command: "status",
        outcome: "success",
        nextStepApplicable: false,
        nextStepPresent: false,
        recoverableError: false,
        extensionCommand: false
      });

      const after = await readExperience(root);
      expect(after.events.length).toBeLessThanOrEqual(500);
      expect(after.first_successful_deployment_at).toBe("2026-05-08T01:00:00.000Z");
      expect(after.first_complete_workflow_at).toBe("2026-05-08T02:00:00.000Z");
    });
  });

  test("default experience uses provided timestamp", () => {
    const def = defaultOperatorExperience("2026-05-08T00:00:00.000Z");
    expect(def.started_at).toBe("2026-05-08T00:00:00.000Z");
    expect(def.events).toEqual([]);
    expect(def.pending_recovery).toBeNull();
  });

  test("renderOperatorExperienceReport prints all required labels", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const experience = await readOperatorExperience(root);
      const metrics = deriveOperatorMetrics(experience);
      const report = renderOperatorExperienceReport(metrics);
      expect(report).toContain("Operator Experience Metrics");
      expect(report).toContain("Command Attempts:");
      expect(report).toContain("Next-Step Coverage:");
      expect(report).toContain("Invalid Command Rate:");
      expect(report).toContain("Help Invocation Rate:");
      expect(report).toContain("Successful Error Recovery Rate:");
      expect(report).toContain("Extension Success Rate:");
      expect(report).toContain("Time To First Successful Workflow:");
      expect(report).toContain("Commands Before Successful Deployment:");
    });
  });
});
