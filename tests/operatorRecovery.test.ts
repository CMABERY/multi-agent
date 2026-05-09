import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  buildRecoveryPacket,
  handleCliError,
  renderRecoveryPacket,
  type RecoveryPacket
} from "../src/operatorRecovery.js";
import { createIntent } from "../src/orchestrator.js";
import { saveJson } from "../src/storage.js";
import { initWorkspace } from "../src/workspace.js";

async function withWorkspace<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "maw-operator-recovery-test-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
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

async function expectPacket(root: string, message: string): Promise<RecoveryPacket> {
  const packet = await buildRecoveryPacket(root, new Error(message));
  expect(packet).toBeDefined();
  return packet as RecoveryPacket;
}

describe("operator recovery packets", () => {
  test("missing approval packet includes repair path", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await seedDeployment(root, { plan: { status: "approved", approval_required: true } });

      const packet = await expectPacket(root, "Deployment DP-001 requires explicit approval before execution.");
      const rendered = renderRecoveryPacket(packet);

      expect(rendered).toContain("Error: Deployment DP-001 requires explicit approval before execution.");
      expect(rendered).toContain("Why: DP-001 requires approval and no approved approval record exists.");
      expect(rendered).toContain("State Safety: safe; execution did not start.");
      expect(rendered).toContain("Corrective Command: maw plan-check --deployment DP-001");
      expect(rendered).toContain("Then: maw approval record --deployment DP-001 --approver \"operator\" --scope \"Run DP-001 after plan-check review.\"");
    });
  });

  test("deployment not approved packet recommends plan check", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await seedDeployment(root);

      const packet = await expectPacket(root, "Deployment DP-001 is not approved. Current status: proposed");

      expect(packet.corrective_command).toBe("maw plan-check --deployment DP-001");
      expect(packet.next_command).toBe("maw approval record --deployment DP-001 --approver \"operator\" --scope \"Run DP-001 after plan-check review.\"");
    });
  });

  test("local command requires execute packet uses active deployment", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await seedDeployment(root, {
        plan: { status: "approved", approval_required: false },
        assignments: [{ agent_id: "shell_1", executor: "local_command" }],
        tasks: [{ owner_agent_id: "shell_1", owner_role: "Shell Agent", executor: "local_command" }]
      });

      const packet = await expectPacket(root, "Local command task T-001 requires --execute.");

      expect(packet.corrective_command).toBe("maw run --deployment DP-001 --execute");
      expect(packet.state_safety).toBe("safe; local command did not run.");
    });
  });

  test("local command not allowlisted packet points back to plan check", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await seedDeployment(root, {
        plan: { status: "approved", approval_required: false },
        assignments: [{ agent_id: "shell_1", executor: "local_command" }],
        tasks: [{ owner_agent_id: "shell_1", owner_role: "Shell Agent", executor: "local_command" }]
      });

      const packet = await expectPacket(root, "Command is not allowlisted for shell_1: node");

      expect(packet.corrective_command).toBe("maw doctor");
      expect(packet.next_command).toBe("maw plan-check --deployment DP-001");
    });
  });

  test("missing api key packet includes PowerShell repair", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);

      const packet = await expectPacket(root, "Missing OpenAI API key environment variable: OPENAI_API_KEY");

      expect(packet.corrective_command).toContain("$env:OPENAI_API_KEY = \"sk-...\"");
      expect(packet.next_command).toBe("maw next");
    });
  });

  test("no structured reviews packet recommends rerun before consensus", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await seedDeployment(root, {
        plan: { status: "completed", approval_required: false },
        tasks: [{ status: "completed", review_required: true }]
      });

      const packet = await expectPacket(root, "No structured reviews found for T-001.");

      expect(packet.corrective_command).toBe("maw run --deployment DP-001 --rerun");
      expect(packet.next_command).toBe("maw consensus compute --task T-001");
    });
  });

  test("context path escapes packet explains safe refusal", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await seedDeployment(root, {
        plan: { status: "approved", approval_required: false },
        tasks: [{ status: "running" }]
      });

      const packet = await expectPacket(root, "Context path escapes workspace: ../secret.txt");

      expect(packet.why).toBe("MAW refuses context paths outside the workspace.");
      expect(packet.state_safety).toBe("safe; unsafe path was not read.");
      expect(packet.corrective_command).toBe("maw doctor");
    });
  });

  test("orchestrator plan failure packet preserves active intent", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await createIntent(root, { text: "Build a verified artifact." });

      const packet = await expectPacket(
        root,
        "Orchestrator could not produce a valid plan after 2 retries. Final violations: DRY_RUN_DELIVERABLE."
      );

      expect(packet.state_safety).toBe("safe; invalid plan was not persisted.");
      expect(packet.corrective_command).toBe("maw doctor");
      expect(packet.next_command).toBe("maw orchestrate --intent I-001");
    });
  });

  test("re-orchestration refusal packet matches the status-and-deployment shape", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);

      const packet = await expectPacket(
        root,
        "Intent I-001 cannot be re-orchestrated (status: planned). Existing deployments: DP-001."
      );

      expect(packet.why).toContain("create a duplicate");
      expect(packet.state_safety).toBe("safe; no orchestration was run.");
      expect(packet.corrective_command).toBe("maw status");
      expect(packet.next_command).toMatch(/^maw intent create/);
    });
  });

  test("re-orchestration refusal packet matches the status-new-but-deployment-exists shape", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);

      const packet = await expectPacket(
        root,
        "Intent I-001 cannot be re-orchestrated (status: new). Existing deployments: DP-001."
      );

      expect(packet.corrective_command).toBe("maw status");
      expect(packet.next_command).toMatch(/^maw intent create/);
    });
  });

  test("re-orchestration refusal packet matches the status-only shape (no deployments)", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);

      const packet = await expectPacket(
        root,
        "Intent I-001 cannot be re-orchestrated (status: blocked)."
      );

      expect(packet.corrective_command).toBe("maw status");
      expect(packet.next_command).toMatch(/^maw intent create/);
    });
  });

  test("no active deployment packet routes to status", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);

      const packet = await expectPacket(
        root,
        "No active deployment. Pass --deployment <id> or run maw status to inspect deployments."
      );

      expect(packet.corrective_command).toBe("maw status");
      expect(packet.next_command).toBe("maw next");
      expect(packet.state_safety).toBe("safe; no command was run.");
    });
  });

  test("no active intent packet routes to status and intent create", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);

      const packet = await expectPacket(
        root,
        "No active intent. Pass --intent <id> or run maw status to inspect intents."
      );

      expect(packet.corrective_command).toBe("maw status");
      expect(packet.next_command).toMatch(/^maw intent create/);
    });
  });

  test("no active task packet routes to status and next", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);

      const packet = await expectPacket(
        root,
        "No active task. Pass --task <id> or run maw status to inspect tasks."
      );

      expect(packet.corrective_command).toBe("maw status");
      expect(packet.next_command).toBe("maw next");
    });
  });

  test("unknown error remains unclassified", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);

      await expect(buildRecoveryPacket(root, new Error("Something totally unexpected"))).resolves.toBeUndefined();
    });
  });

  test("render format is stable", () => {
    const rendered = renderRecoveryPacket({
      recoverable: true,
      error_summary: "Example failure.",
      why: "Example reason.",
      state_safety: "safe; no action was taken.",
      corrective_command: "maw status",
      next_command: "maw next"
    });

    expect(rendered).toBe(
      [
        "Error: Example failure.",
        "Why: Example reason.",
        "State Safety: safe; no action was taken.",
        "Corrective Command: maw status",
        "Then: maw next"
      ].join("\n")
    );
  });

  test("cli error handler writes packet and sets exit code", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await seedDeployment(root, { plan: { status: "approved", approval_required: true } });
      const previousExitCode = process.exitCode;
      process.exitCode = undefined;
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        await handleCliError(root, new Error("Deployment DP-001 requires explicit approval before execution."));

        expect(error).toHaveBeenCalledTimes(1);
        expect(String(error.mock.calls[0]?.[0])).toContain("Corrective Command: maw plan-check --deployment DP-001");
        expect(process.exitCode).toBe(1);
      } finally {
        error.mockRestore();
        process.exitCode = previousExitCode;
      }
    });
  });
});
