import { nextId } from "./ids.js";
import {
  TransactionStoreSchema,
  type Transaction,
  type TransactionStatus
} from "./schemas.js";
import { loadJsonOrDefault, nowIso, saveJson } from "./storage.js";

const TERMINAL_STATUSES: ReadonlySet<TransactionStatus> = new Set([
  "Committed",
  "Failed",
  "Aborted"
]);

export async function beginTransaction(
  root: string,
  input: {
    deploymentId?: string;
    taskId: string;
    agentId: string;
    actionKind: string;
    actionSignals: Record<string, string | number>;
    permissionAuditEventId?: string;
  }
): Promise<Transaction> {
  const store = TransactionStoreSchema.parse(
    await loadJsonOrDefault(root, "state/transactions.json", { transactions: [] })
  );
  const startedAt = nowIso();
  const transaction: Transaction = {
    transaction_id: nextId(
      "TX",
      store.transactions.map((entry) => entry.transaction_id)
    ),
    deployment_id: input.deploymentId,
    task_id: input.taskId,
    agent_id: input.agentId,
    action_kind: input.actionKind,
    action_signals: input.actionSignals,
    status: "Planned",
    permission_audit_event_id: input.permissionAuditEventId,
    started_at: startedAt,
    updated_at: startedAt
  };
  store.transactions.push(transaction);
  await saveJson(root, "state/transactions.json", store);
  return transaction;
}

export async function markTransaction(
  root: string,
  transactionId: string,
  input: { status: TransactionStatus; failureReason?: string }
): Promise<Transaction> {
  const store = TransactionStoreSchema.parse(
    await loadJsonOrDefault(root, "state/transactions.json", { transactions: [] })
  );
  const index = store.transactions.findIndex(
    (entry) => entry.transaction_id === transactionId
  );
  if (index < 0) throw new Error("Transaction not found: " + transactionId);
  const existing = store.transactions[index]!;
  if (TERMINAL_STATUSES.has(existing.status)) return existing;
  const now = nowIso();
  const updated: Transaction = {
    ...existing,
    status: input.status,
    updated_at: now,
    completed_at: TERMINAL_STATUSES.has(input.status) ? now : existing.completed_at,
    failure_reason: input.failureReason ?? existing.failure_reason
  };
  store.transactions[index] = updated;
  await saveJson(root, "state/transactions.json", store);
  return updated;
}
