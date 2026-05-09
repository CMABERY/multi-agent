import {
  DeploymentPlanStoreSchema,
  TransactionStatusSchema,
  TransactionStoreSchema,
  type Transaction,
  type TransactionStatus
} from "./schemas.js";
import { loadJsonOrDefault } from "./storage.js";

export interface TransactionStatusSummary {
  counts: Record<TransactionStatus, number>;
  recent_non_committed: Transaction[];
}

const RECENT_LIMIT = 5;

export async function readTransactionSummary(
  root: string
): Promise<TransactionStatusSummary> {
  const store = TransactionStoreSchema.parse(
    await loadJsonOrDefault(root, "state/transactions.json", { transactions: [] })
  );
  const counts = emptyCounts();
  for (const tx of store.transactions) counts[tx.status] += 1;
  const recent_non_committed = [...store.transactions]
    .filter((tx) => tx.status !== "Committed")
    .sort((left, right) => timestampValue(right.started_at) - timestampValue(left.started_at))
    .slice(0, RECENT_LIMIT);
  return { counts, recent_non_committed };
}

export async function findActionableTransactions(
  root: string,
  deploymentId: string
): Promise<Transaction[]> {
  const store = TransactionStoreSchema.parse(
    await loadJsonOrDefault(root, "state/transactions.json", { transactions: [] })
  );
  return store.transactions.filter(
    (tx) =>
      tx.deployment_id === deploymentId &&
      (tx.status === "Failed" || tx.status === "Aborted")
  );
}

export async function resolveDoctorDeploymentId(
  root: string,
  activeDeploymentId: string | undefined
): Promise<string | undefined> {
  if (activeDeploymentId) return activeDeploymentId;
  const plans = DeploymentPlanStoreSchema.parse(
    await loadJsonOrDefault(root, "state/deployment_plan.json", { deployment_plans: [] })
  );
  const sorted = [...plans.deployment_plans].sort(
    (left, right) => timestampValue(right.updated_at) - timestampValue(left.updated_at)
  );
  return sorted[0]?.deployment_id;
}

function emptyCounts(): Record<TransactionStatus, number> {
  const counts = {} as Record<TransactionStatus, number>;
  for (const status of TransactionStatusSchema.options) counts[status] = 0;
  return counts;
}

function timestampValue(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
