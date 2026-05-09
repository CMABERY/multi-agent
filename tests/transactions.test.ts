import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { registerAgent } from "../src/agents.js";
import { runPlanCheck } from "../src/planCheck.js";
import { runDeployment } from "../src/runner.js";
import { loadJson, saveJson } from "../src/storage.js";
import { initWorkspace } from "../src/workspace.js";

async function withWorkspace<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "maw-tx-test-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

interface SetupOptions {
  policyGrants: Array<"LocalCommandExecute">;
  command: { command: string; args: string[] };
  bypassPlanCheck?: boolean;
}

async function setupCommandDeployment(root: string, options: SetupOptions): Promise<void> {
  await initWorkspace(root);
  await registerAgent(root, {
    agent_id: "shell_1",
    role: "Local Shell Agent",
    executor_type: "local_command",
    allowed_tools: ["shell"],
    command_allowlist: [options.command.command],
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
        title: "Run command",
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
        command: options.command,
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
            reason: "Run command.",
            approval_required: false
          }
        ],
        created_at: "2026-05-08T00:00:00.000Z",
        updated_at: "2026-05-08T00:00:00.000Z"
      }
    ]
  });
  if (options.bypassPlanCheck) {
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
}

describe("transaction envelope around local_command", () => {
  test("policy denial creates a Planned-then-Aborted transaction with no spawn artifacts", async () => {
    await withWorkspace(async (root) => {
      await setupCommandDeployment(root, {
        policyGrants: [],
        command: { command: "node", args: ["-e", "console.log('ok')"] },
        bypassPlanCheck: true
      });
      const result = await runDeployment(root, { deploymentId: "DP-001", execute: true });
      expect(result.completed).toEqual([]);
      expect(result.failed).toEqual(["T-001"]);

      const txStore = await loadJson(root, "state/transactions.json");
      expect(txStore.transactions).toHaveLength(1);
      const tx = txStore.transactions[0];
      expect(tx).toMatchObject({
        deployment_id: "DP-001",
        task_id: "T-001",
        agent_id: "shell_1",
        action_kind: "command.execute",
        status: "Aborted"
      });
      expect(tx.failure_reason).toContain("LocalCommandExecute");
      expect(tx.permission_audit_event_id).toMatch(/^PA-\d{3,}$/);
      expect(tx.action_signals).toMatchObject({ command_name: "node", arg_count: 2 });
      expect(tx.completed_at).toBeTruthy();

      // Spawn artifacts must not exist for an Aborted transaction.
      await expect(
        loadJson(root, "artifacts/runs/T-001/command_result.json")
      ).rejects.toThrow();
    });
  });

  test("successful command produces a Committed transaction linked to the allow audit event", async () => {
    await withWorkspace(async (root) => {
      await setupCommandDeployment(root, {
        policyGrants: ["LocalCommandExecute"],
        command: { command: "node", args: ["-e", "console.log('ok')"] }
      });
      await runPlanCheck(root, { deploymentId: "DP-001" });
      const result = await runDeployment(root, { deploymentId: "DP-001", execute: true });
      expect(result.completed).toEqual(["T-001"]);
      expect(result.failed).toEqual([]);

      const txStore = await loadJson(root, "state/transactions.json");
      expect(txStore.transactions).toHaveLength(1);
      const tx = txStore.transactions[0];
      expect(tx.status).toBe("Committed");
      expect(tx.failure_reason).toBeUndefined();
      expect(tx.completed_at).toBeTruthy();
      expect(tx.permission_audit_event_id).toMatch(/^PA-\d{3,}$/);

      const audit = await loadJson(root, "state/permission_audit.json");
      const linkedEvent = audit.events.find(
        (event: { event_id: string }) => event.event_id === tx.permission_audit_event_id
      );
      expect(linkedEvent).toBeTruthy();
      expect(linkedEvent.decision).toBe("allow");
      expect(linkedEvent.action_kind).toBe("command.execute");

      const commandResult = await loadJson(root, "artifacts/runs/T-001/command_result.json");
      expect(commandResult.exit_code).toBe(0);
    });
  });

  test("nonzero exit produces a Failed transaction with the exit-code reason", async () => {
    await withWorkspace(async (root) => {
      await setupCommandDeployment(root, {
        policyGrants: ["LocalCommandExecute"],
        command: { command: "node", args: ["-e", "process.exit(3)"] }
      });
      await runPlanCheck(root, { deploymentId: "DP-001" });
      const result = await runDeployment(root, { deploymentId: "DP-001", execute: true });
      expect(result.completed).toEqual([]);
      expect(result.failed).toEqual(["T-001"]);

      const txStore = await loadJson(root, "state/transactions.json");
      expect(txStore.transactions).toHaveLength(1);
      const tx = txStore.transactions[0];
      expect(tx.status).toBe("Failed");
      expect(tx.failure_reason).toContain("exit");
      expect(tx.failure_reason).toContain("3");
      expect(tx.completed_at).toBeTruthy();
      expect(tx.permission_audit_event_id).toMatch(/^PA-\d{3,}$/);

      // Spawn happened, so command_result.json should exist.
      const commandResult = await loadJson(root, "artifacts/runs/T-001/command_result.json");
      expect(commandResult.exit_code).toBe(3);
    });
  });

  test("transactions accumulate monotonic ids across multiple commands", async () => {
    await withWorkspace(async (root) => {
      await setupCommandDeployment(root, {
        policyGrants: ["LocalCommandExecute"],
        command: { command: "node", args: ["-e", "console.log('ok')"] }
      });
      await runPlanCheck(root, { deploymentId: "DP-001" });
      await runDeployment(root, { deploymentId: "DP-001", execute: true });

      // Reset task to queued and re-run.
      const board = await loadJson(root, "state/task_board.json");
      board.tasks[0].status = "queued";
      await saveJson(root, "state/task_board.json", board);
      const plan = await loadJson(root, "state/deployment_plan.json");
      plan.deployment_plans[0].status = "approved";
      await saveJson(root, "state/deployment_plan.json", plan);
      await runPlanCheck(root, { deploymentId: "DP-001" });
      await runDeployment(root, { deploymentId: "DP-001", execute: true, rerun: true });

      const txStore = await loadJson(root, "state/transactions.json");
      expect(txStore.transactions).toHaveLength(2);
      expect(txStore.transactions[0].transaction_id).toBe("TX-001");
      expect(txStore.transactions[1].transaction_id).toBe("TX-002");
    });
  });
});
