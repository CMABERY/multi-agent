import {
  AgentRegistrySchema,
  ApprovalStoreSchema,
  ArtifactIndexSchema,
  ConsensusStoreSchema,
  DeploymentPlanStoreSchema,
  ReviewLogSchema,
  TaskBoardSchema
} from "./schemas.js";
import { hasLegacyReviews, migrateLegacyReviews } from "./reviews.js";
import { loadJson, loadJsonOrDefault } from "./storage.js";

export interface ValidationIssue {
  code: string;
  message: string;
  path?: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

export async function validateWorkspace(root: string): Promise<ValidationResult> {
  const issues: ValidationIssue[] = [];
  const registryResult = AgentRegistrySchema.safeParse(await loadJson(root, "state/agent_registry.json"));
  const boardResult = TaskBoardSchema.safeParse(await loadJson(root, "state/task_board.json"));
  const planResult = DeploymentPlanStoreSchema.safeParse(await loadJson(root, "state/deployment_plan.json"));
  const approvalResult = ApprovalStoreSchema.safeParse(await loadJson(root, "state/approvals.json"));
  const artifactResult = ArtifactIndexSchema.safeParse(await loadJson(root, "artifacts/artifact_index.json"));
  const rawReviews = await loadJson(root, "state/review_log.json");
  if (hasLegacyReviews(rawReviews) && boardResult.success) {
    await migrateLegacyReviews(root);
  }
  const reviewResult = ReviewLogSchema.safeParse(await loadJson(root, "state/review_log.json"));
  const consensusResult = ConsensusStoreSchema.safeParse(
    await loadJsonOrDefault(root, "state/consensus.json", { consensus_records: [] })
  );

  for (const [name, result] of [
    ["agent_registry", registryResult],
    ["task_board", boardResult],
    ["deployment_plan", planResult],
    ["approvals", approvalResult],
    ["artifact_index", artifactResult],
    ["review_log", reviewResult],
    ["consensus", consensusResult]
  ] as const) {
    if (!result.success) {
      issues.push({ code: "SCHEMA_INVALID", message: `${name} is invalid: ${result.error.message}` });
    }
  }
  if (
    !registryResult.success ||
    !boardResult.success ||
    !planResult.success ||
    !approvalResult.success ||
    !artifactResult.success ||
    !reviewResult.success ||
    !consensusResult.success
  ) {
    return { valid: false, issues };
  }

  const agents = new Set(registryResult.data.agents.map((agent) => agent.agent_id));
  const tasks = new Map(boardResult.data.tasks.map((task) => [task.task_id, task]));
  const approvals = approvalResult.data.approvals;
  const artifacts = new Set(artifactResult.data.artifacts.map((artifact) => artifact.artifact_id));
  const passingConsensus = new Set(
    consensusResult.data.consensus_records
      .filter((consensus) => consensus.is_load_bearing && consensus.overall_verdict === "pass")
      .map((consensus) => consensus.task_id)
  );

  for (const task of boardResult.data.tasks) {
    if (!agents.has(task.owner_agent_id)) {
      issues.push({
        code: "TASK_OWNER_MISSING",
        message: `Task ${task.task_id} references missing owner ${task.owner_agent_id}`
      });
    }
    for (const dependency of task.dependencies) {
      if (!tasks.has(dependency)) {
        issues.push({
          code: "TASK_DEPENDENCY_MISSING",
          message: `Task ${task.task_id} depends on missing task ${dependency}`
        });
      }
    }
    if (task.approval_required) {
      const approved = approvals.some(
        (approval) => approval.deployment_id === task.deployment_id && approval.decision === "approved"
      );
      if (!approved) {
        issues.push({
          code: "TASK_APPROVAL_MISSING",
          message: `Task ${task.task_id} requires approval but no approved deployment record exists`
        });
      }
    }
    if (task.review_required && task.status === "completed" && !passingConsensus.has(task.task_id)) {
      issues.push({
        code: "TASK_REVIEW_MISSING",
        message: `Task ${task.task_id} is completed but lacks passing load-bearing consensus`
      });
    }
    for (const artifactId of task.artifacts) {
      if (!artifacts.has(artifactId)) {
        issues.push({
          code: "ARTIFACT_MISSING",
          message: `Task ${task.task_id} references missing artifact ${artifactId}`
        });
      }
    }
  }

  for (const plan of planResult.data.deployment_plans) {
    for (const assignment of plan.assignments) {
      if (!tasks.has(assignment.task_id)) {
        issues.push({
          code: "DEPLOYMENT_TASK_MISSING",
          message: `Deployment ${plan.deployment_id} references missing task ${assignment.task_id}`
        });
      }
      if (!agents.has(assignment.agent_id)) {
        issues.push({
          code: "DEPLOYMENT_AGENT_MISSING",
          message: `Deployment ${plan.deployment_id} references missing agent ${assignment.agent_id}`
        });
      }
    }
  }

  return { valid: issues.length === 0, issues };
}
