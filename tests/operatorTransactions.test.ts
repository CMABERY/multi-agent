import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { createCli } from "../src/cli.js";
import { runOperatorDoctor } from "../src/operatorDoctor.js";
import { readTransactionSummary } from "../src/operatorTransactions.js";
import { saveJson } from "../src/storage.js";
import { initWorkspace } from "../src/workspace.js";

async function withWorkspace<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "maw-op-tx-test-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runCli(root: string, args: string[]): Promise<string> {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
    lines.push(String(message ?? ""));
  });
  const error = vi.spyOn(console, "error").mockImplementation((message?: unknown) => {
    lines.push(String(message ?? ""));
  });
  const program = createCli(root);
  program.exitOverride();
  try {
    await program.parseAsync(["node", "maw", ...args], { from: "node" });
  } finally {
    log.mockRestore();
    error.mockRestore();
    process.exitCode = undefined;
  }
  return lines.join("\n");
}

function deployment(id: string, updatedAt: string) {
  return {
    deployment_id: id,
    intent_id: "I-001",
    status: "completed",
    approval_required: false,
    assignments: [
      {
        task_id: "T-001",
        agent_id: "shell_1",
        executor: "local_command",
        model_tier: "low",
        reason: "x",
        approval_required: false
      }
    ],
    created_at: "2026-05-08T00:00:00.000Z",
    updated_at: updatedAt
  };
}

function tx(overrides: Record<string, unknown>) {
  return {
    transaction_id: "TX-001",
    deployment_id: "DP-001",
    task_id: "T-001",
    agent_id: "shell_1",
    action_kind: "command.execute",
    action_signals: { command_name: "node", arg_count: 0 },
    status: "Planned",
    permission_audit_event_id: "PA-001",
    started_at: "2026-05-08T00:00:00.000Z",
    updated_at: "2026-05-08T00:00:00.000Z",
    ...overrides
  };
}

describe("readTransactionSummary", () => {
  test("counts by status and returns the most recent five non-Committed", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await saveJson(root, "state/transactions.json", {
        transactions: [
          tx({
            transaction_id: "TX-001",
            status: "Committed",
            started_at: "2026-05-08T00:00:00.000Z"
          }),
          tx({
            transaction_id: "TX-002",
            status: "Failed",
            started_at: "2026-05-08T00:01:00.000Z",
            failure_reason: "Command exited with code 1"
          }),
          tx({
            transaction_id: "TX-003",
            status: "Aborted",
            started_at: "2026-05-08T00:02:00.000Z",
            failure_reason: "missing grant"
          }),
          tx({
            transaction_id: "TX-004",
            status: "Planned",
            started_at: "2026-05-08T00:03:00.000Z"
          }),
          tx({
            transaction_id: "TX-005",
            status: "Failed",
            started_at: "2026-05-08T00:04:00.000Z"
          }),
          tx({
            transaction_id: "TX-006",
            status: "Aborted",
            started_at: "2026-05-08T00:05:00.000Z"
          }),
          tx({
            transaction_id: "TX-007",
            status: "Failed",
            started_at: "2026-05-08T00:06:00.000Z"
          })
        ]
      });
      const summary = await readTransactionSummary(root);
      expect(summary.counts).toEqual({
        Planned: 1,
        Committed: 1,
        Failed: 3,
        Aborted: 2
      });
      expect(summary.recent_non_committed.map((entry) => entry.transaction_id)).toEqual([
        "TX-007",
        "TX-006",
        "TX-005",
        "TX-004",
        "TX-003"
      ]);
    });
  });

  test("returns zero counts and empty list for an empty store", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const summary = await readTransactionSummary(root);
      expect(summary.counts).toEqual({
        Planned: 0,
        Committed: 0,
        Failed: 0,
        Aborted: 0
      });
      expect(summary.recent_non_committed).toEqual([]);
    });
  });
});

describe("status command surface", () => {
  test("renders transaction counts and recent non-Committed entries", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await saveJson(root, "state/transactions.json", {
        transactions: [
          tx({
            transaction_id: "TX-001",
            status: "Committed"
          }),
          tx({
            transaction_id: "TX-002",
            status: "Aborted",
            started_at: "2026-05-08T00:01:00.000Z",
            failure_reason: "Local command denied: missing LocalCommandExecute"
          }),
          tx({
            transaction_id: "TX-003",
            status: "Failed",
            started_at: "2026-05-08T00:02:00.000Z",
            failure_reason: "Command exited with code 2"
          })
        ]
      });
      const output = await runCli(root, ["status"]);
      expect(output).toContain("Transactions:");
      expect(output).toContain(
        "- Counts: Planned=0 Committed=1 Failed=1 Aborted=1"
      );
      expect(output).toContain("- Recent non-Committed:");
      expect(output).toContain("TX-003 [Failed] command.execute T-001/shell_1: Command exited with code 2");
      expect(output).toContain("TX-002 [Aborted] command.execute T-001/shell_1: Local command denied");
      expect(output).not.toContain("TX-001");
    });
  });

  test("reports 'none' when there are no non-Committed transactions", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const output = await runCli(root, ["status"]);
      expect(output).toContain("- Counts: Planned=0 Committed=0 Failed=0 Aborted=0");
      expect(output).toContain("- Recent non-Committed: none");
    });
  });
});

describe("doctor scope window for transaction findings", () => {
  test("surfaces Failed and Aborted transactions for the active deployment", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await saveJson(root, "state/deployment_plan.json", {
        deployment_plans: [deployment("DP-001", "2026-05-08T00:10:00.000Z")]
      });
      await saveJson(root, "state/transactions.json", {
        transactions: [
          tx({
            transaction_id: "TX-100",
            deployment_id: "DP-001",
            status: "Aborted",
            failure_reason: "Local command denied: missing LocalCommandExecute"
          }),
          tx({
            transaction_id: "TX-101",
            deployment_id: "DP-001",
            status: "Failed",
            failure_reason: "Command exited with code 2"
          })
        ]
      });
      const report = await runOperatorDoctor(root);
      const codes = report.findings.map((finding) => finding.code);
      expect(codes).toContain("TRANSACTION_ABORTED");
      expect(codes).toContain("TRANSACTION_FAILED");
      const aborted = report.findings.find((f) => f.code === "TRANSACTION_ABORTED");
      expect(aborted?.target).toBe("TX-100");
      expect(aborted?.message).toContain("PA-001");
      expect(aborted?.repair).toContain("plan-check");
      const failed = report.findings.find((f) => f.code === "TRANSACTION_FAILED");
      expect(failed?.target).toBe("TX-101");
      expect(failed?.repair).toContain("--rerun --execute");
    });
  });

  test("falls back to most-recent deployment by updated_at when none is active", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await saveJson(root, "state/deployment_plan.json", {
        deployment_plans: [
          deployment("DP-001", "2026-05-08T00:10:00.000Z"),
          deployment("DP-002", "2026-05-08T00:20:00.000Z")
        ]
      });
      await saveJson(root, "state/transactions.json", {
        transactions: [
          tx({
            transaction_id: "TX-100",
            deployment_id: "DP-001",
            status: "Failed",
            failure_reason: "old"
          }),
          tx({
            transaction_id: "TX-200",
            deployment_id: "DP-002",
            status: "Failed",
            failure_reason: "new"
          })
        ]
      });
      const report = await runOperatorDoctor(root);
      const targets = report.findings
        .filter((finding) => finding.code === "TRANSACTION_FAILED")
        .map((finding) => finding.target);
      expect(targets).toEqual(["TX-200"]);
    });
  });

  test("does not surface transactions from older deployments as actionable findings", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await saveJson(root, "state/deployment_plan.json", {
        deployment_plans: [
          deployment("DP-001", "2026-05-08T00:10:00.000Z"),
          deployment("DP-002", "2026-05-08T00:20:00.000Z")
        ]
      });
      await saveJson(root, "state/transactions.json", {
        transactions: [
          tx({
            transaction_id: "TX-099",
            deployment_id: "DP-001",
            status: "Aborted",
            failure_reason: "old aborted"
          })
        ]
      });
      const report = await runOperatorDoctor(root);
      const txCodes = report.findings
        .map((finding) => finding.code)
        .filter((code) => code === "TRANSACTION_ABORTED" || code === "TRANSACTION_FAILED");
      expect(txCodes).toEqual([]);
    });
  });

  test("returns no transaction findings when no deployments exist", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await saveJson(root, "state/transactions.json", {
        transactions: [
          tx({
            transaction_id: "TX-100",
            deployment_id: "DP-001",
            status: "Failed"
          })
        ]
      });
      const report = await runOperatorDoctor(root);
      const txCodes = report.findings
        .map((finding) => finding.code)
        .filter((code) => code === "TRANSACTION_ABORTED" || code === "TRANSACTION_FAILED");
      expect(txCodes).toEqual([]);
    });
  });
});
