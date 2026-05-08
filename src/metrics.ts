import { MetricsSchema } from "./schemas.js";
import { loadJson, saveJson } from "./storage.js";

export type MetricCounterKey =
  | "model_calls"
  | "local_commands"
  | "dry_runs"
  | "tasks_completed"
  | "tasks_failed";

export async function incrementMetric(
  root: string,
  key: MetricCounterKey,
  costDelta = 0
): Promise<void> {
  const metrics = MetricsSchema.parse(await loadJson(root, "state/metrics.json"));
  metrics[key] += 1;
  metrics.estimated_cost_usd += costDelta;
  await saveJson(root, "state/metrics.json", metrics);
}
