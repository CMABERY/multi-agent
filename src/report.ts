import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ApprovalStoreSchema,
  DeploymentPlanStoreSchema,
  IntentQueueSchema,
  MetricsSchema,
  ReviewLogSchema,
  TaskBoardSchema
} from "./schemas.js";
import { loadJson } from "./storage.js";

export async function generateReport(root: string): Promise<string> {
  const intents = IntentQueueSchema.parse(await loadJson(root, "state/intent_queue.json"));
  const tasks = TaskBoardSchema.parse(await loadJson(root, "state/task_board.json"));
  const plans = DeploymentPlanStoreSchema.parse(await loadJson(root, "state/deployment_plan.json"));
  const approvals = ApprovalStoreSchema.parse(await loadJson(root, "state/approvals.json"));
  const reviews = ReviewLogSchema.parse(await loadJson(root, "state/review_log.json"));
  const metrics = MetricsSchema.parse(await loadJson(root, "state/metrics.json"));
  const decisions = await readFile(join(root, "state/decision_log.md"), "utf8");

  return [
    "# Multi-Agent Workflow Report",
    "",
    "## Intents",
    ...intents.intents.map((intent) => "- " + (intent.intent_id) + " [" + (intent.status) + "]: " + (intent.text)),
    "",
    "## Deployments",
    ...plans.deployment_plans.map(
      (plan) =>
        "- " + (plan.deployment_id) + " [" + (plan.status) + "] intent=" + (plan.intent_id) + " approval_required=" + (plan.approval_required)
    ),
    "",
    "## Tasks",
    ...tasks.tasks.map(
      (task) =>
        "- " + (task.task_id) + " [" + (task.status) + "] " + (task.title) + " owner=" + (task.owner_agent_id) + " executor=" + (task.executor)
    ),
    "",
    "## Approvals",
    ...approvals.approvals.map(
      (approval) =>
        "- " + (approval.approval_id) + " " + (approval.decision) + " deployment=" + (approval.deployment_id) + " approver=" + (approval.approver) + " scope=" + (approval.scope)
    ),
    "",
    "## Reviews",
    ...reviews.reviews.map((review) => "- " + (review.review_id) + " " + (review.status) + " task=" + (review.task_id)),
    "",
    "## Decisions",
    decisions.trim(),
    "",
    "## Metrics",
    "- Model Calls: " + (metrics.model_calls),
    "- Local Commands: " + (metrics.local_commands),
    "- Dry Runs: " + (metrics.dry_runs),
    "- Tasks Completed: " + (metrics.tasks_completed),
    "- Tasks Failed: " + (metrics.tasks_failed),
    "- Estimated Cost USD: " + (metrics.estimated_cost_usd.toFixed(4)),
    ""
  ].join("\n");
}
