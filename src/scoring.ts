import { nextId } from "./ids.js";
import {
  ApprovalStoreSchema,
  ConsensusStoreSchema,
  ContextCheckStoreSchema,
  MetricsSchema,
  WorkflowScoreStoreSchema,
  type ArtifactIndex,
  type DeploymentAssignment,
  type Task,
  type WorkflowScore
} from "./schemas.js";
import { deploymentTaskIds, loadDeploymentContext, taskArtifacts } from "./intelligenceCommon.js";
import { loadJson, loadJsonOrDefault, nowIso, saveJson } from "./storage.js";

const deliverableArtifactTypes = new Set(["model_output", "command_output", "delegation_packet"]);

export async function writeWorkflowScore(
  root: string,
  input: { deploymentId: string }
): Promise<WorkflowScore> {
  const { plan, tasks, artifactIndex } = await loadDeploymentContext(root, input.deploymentId);
  const deploymentIds = deploymentTaskIds(plan);
  const consensusStore = ConsensusStoreSchema.parse(
    await loadJsonOrDefault(root, "state/consensus.json", { consensus_records: [] })
  );
  const metrics = MetricsSchema.parse(await loadJson(root, "state/metrics.json"));
  const approvals = ApprovalStoreSchema.parse(await loadJson(root, "state/approvals.json"));
  const contextChecks = ContextCheckStoreSchema.parse(
    await loadJsonOrDefault(root, "state/context_checks.json", { context_checks: [] })
  );
  const store = WorkflowScoreStoreSchema.parse(
    await loadJsonOrDefault(root, "state/workflow_score.json", { workflow_scores: [] })
  );

  const reviewRequiredTasks = tasks.filter((task) => task.review_required);
  const loadBearingConsensus = consensusStore.consensus_records.filter(
    (consensus) => deploymentIds.has(consensus.task_id) && consensus.is_load_bearing
  );
  const consensusByTask = new Map(loadBearingConsensus.map((consensus) => [consensus.task_id, consensus]));
  const verifiedUsefulOutputs = reviewRequiredTasks.filter((task) =>
    consensusByTask.get(task.task_id)?.overall_verdict === "pass"
  ).length;
  const consensusPassCount = loadBearingConsensus.filter(
    (consensus) => consensus.overall_verdict === "pass"
  ).length;
  const consensusSplitCount = loadBearingConsensus.filter(
    (consensus) => consensus.overall_verdict === "split"
  ).length;
  const consensusInsufficientCount = loadBearingConsensus.filter(
    (consensus) => consensus.overall_verdict === "insufficient"
  ).length;
  const failedTasks = tasks.filter((task) => task.status === "failed").length;
  const completedOrApproved = tasks.filter(
    (task) => task.status === "completed" || task.status === "approved"
  ).length;
  const rerunCount = countArtifactReruns(plan.assignments, tasks, artifactIndex);
  const contextFailures = contextChecks.context_checks.filter(
    (check) => deploymentIds.has(check.task_id) && check.status === "fail"
  ).length;
  const humanInterventions = approvals.approvals.filter(
    (approval) => approval.deployment_id === plan.deployment_id
  ).length;
  const reviewPassRate =
    reviewRequiredTasks.length === 0 ? 1 : verifiedUsefulOutputs / reviewRequiredTasks.length;
  const denominator =
    1 +
    metrics.model_calls +
    metrics.dry_runs +
    failedTasks * 3 +
    rerunCount * 2 +
    consensusSplitCount * 2 +
    humanInterventions +
    contextFailures * 2;

  const score: WorkflowScore = {
    score_id:
      store.workflow_scores.find((entry) => entry.deployment_id === plan.deployment_id)?.score_id ??
      nextId(
        "WS",
        store.workflow_scores.map((entry) => entry.score_id)
      ),
    deployment_id: plan.deployment_id,
    verified_useful_outputs: verifiedUsefulOutputs,
    consensus_pass_count: consensusPassCount,
    consensus_split_count: consensusSplitCount,
    consensus_insufficient_count: consensusInsufficientCount,
    review_pass_rate: reviewPassRate,
    failed_tasks: failedTasks,
    rerun_count: rerunCount,
    human_interventions: humanInterventions,
    context_failures: contextFailures,
    model_calls: metrics.model_calls,
    dry_runs: metrics.dry_runs,
    workflow_intelligence_yield: completedOrApproved === 0 ? 0 : verifiedUsefulOutputs / denominator,
    created_at:
      store.workflow_scores.find((entry) => entry.deployment_id === plan.deployment_id)?.created_at ??
      nowIso(),
    updated_at: nowIso()
  };

  const existingIndex = store.workflow_scores.findIndex(
    (entry) => entry.deployment_id === score.deployment_id
  );
  if (existingIndex >= 0) store.workflow_scores[existingIndex] = score;
  else store.workflow_scores.push(score);
  await saveJson(root, "state/workflow_score.json", store);
  return score;
}

function countArtifactReruns(
  assignments: DeploymentAssignment[],
  tasks: Task[],
  artifactIndex: ArtifactIndex
): number {
  return assignments.reduce((total, assignment) => {
    const task = tasks.find((entry) => entry.task_id === assignment.task_id);
    const artifactCount = task
      ? taskArtifacts(task, artifactIndex.artifacts).filter(
          (artifact) =>
            artifact.task_id === assignment.task_id &&
            deliverableArtifactTypes.has(artifact.type)
        ).length
      : 0;
    return total + Math.max(0, artifactCount - 1);
  }, 0);
}
