import { nextId } from "./ids.js";
import {
  ModelConfigSchema,
  PlanCheckStoreSchema,
  type Agent,
  type AgentRegistry,
  type Artifact,
  type ArtifactIndex,
  type DeploymentAssignment,
  type DeploymentPlan,
  type IntelligenceIssue,
  type ModelConfig,
  type PlanCheck,
  type Task
} from "./schemas.js";
import {
  isDeliverableTask,
  isReviewOrSynthesisTask,
  loadDeploymentContext,
  makeIssue,
  taskArtifacts
} from "./intelligenceCommon.js";
import { loadModelConfig } from "./openai.js";
import { loadJsonOrDefault, nowIso, saveJson } from "./storage.js";

const deliverableArtifactTypes = new Set(["model_output", "command_output"]);
const defaultPlanCheckConfig = ModelConfigSchema.parse({
  provider: "openai",
  base_url: "https://api.openai.com/v1",
  api_key_env: "OPENAI_API_KEY",
  default_models: {
    orchestrator: "gpt-5.2",
    high: "gpt-5.2",
    mid: "gpt-5-mini",
    low: "gpt-5-nano"
  }
});

export async function runPlanCheck(
  root: string,
  input: { deploymentId: string }
): Promise<PlanCheck> {
  const { plan, registry, artifactIndex, tasks } = await loadDeploymentContext(
    root,
    input.deploymentId
  );
  const store = PlanCheckStoreSchema.parse(
    await loadJsonOrDefault(root, "state/plan_checks.json", { plan_checks: [] })
  );
  const config = await loadModelConfig(root);
  const issues = collectPlanIssues({ plan, tasks, registry, artifactIndex, config });

  const existingIndex = store.plan_checks.findIndex(
    (entry) => entry.deployment_id === plan.deployment_id
  );
  const existing = existingIndex >= 0 ? store.plan_checks[existingIndex] : undefined;
  const check: PlanCheck = {
    check_id:
      existing?.check_id ??
      nextId(
        "PC",
        store.plan_checks.map((entry) => entry.check_id)
      ),
    deployment_id: plan.deployment_id,
    status: issues.some((issue) => issue.severity === "high") ? "fail" : "pass",
    issues,
    created_at: existing?.created_at ?? nowIso(),
    updated_at: nowIso()
  };
  if (existingIndex >= 0) store.plan_checks[existingIndex] = check;
  else store.plan_checks.push(check);
  await saveJson(root, "state/plan_checks.json", store);
  return check;
}

export function collectPlanIssues(input: {
  plan: DeploymentPlan;
  tasks: Task[];
  registry: AgentRegistry;
  artifactIndex: ArtifactIndex;
  config?: ModelConfig;
}): IntelligenceIssue[] {
  const issues: IntelligenceIssue[] = [];
  const config = input.config ?? defaultPlanCheckConfig;
  const taskById = new Map(input.tasks.map((task) => [task.task_id, task]));
  const agentById = new Map(input.registry.agents.map((agent) => [agent.agent_id, agent]));
  const assignmentByTaskId = new Map(
    input.plan.assignments.map((assignment) => [assignment.task_id, assignment])
  );
  const reviewerPersonaCount = new Set(
    input.registry.agents
      .filter((agent) => agent.role.includes("Reviewer") && agent.reviewer_persona)
      .map((agent) => agent.reviewer_persona)
  ).size;

  for (const assignment of input.plan.assignments) {
    const task = taskById.get(assignment.task_id);
    const agent = agentById.get(assignment.agent_id);
    if (!task) {
      issues.push(
        makeIssue(issues, {
          severity: "high",
          code: "ASSIGNMENT_TASK_MISSING",
          target: assignment.task_id,
          message: `Assignment references missing task ${assignment.task_id}.`,
          recommended_fix: "Remove the assignment or create the referenced task."
        })
      );
      continue;
    }
    if (!agent) {
      issues.push(
        makeIssue(issues, {
          severity: "high",
          code: "ASSIGNMENT_AGENT_MISSING",
          target: assignment.agent_id,
          message: `Assignment references missing agent ${assignment.agent_id}.`,
          recommended_fix: "Register the agent or route the task to an existing agent."
        })
      );
    } else if (agent.executor_type !== assignment.executor) {
      issues.push(
        makeIssue(issues, {
          severity: "high",
          code: "EXECUTOR_REGISTRY_MISMATCH",
          target: `${assignment.task_id}/${assignment.agent_id}`,
          message: `Assignment executor ${assignment.executor} conflicts with registered executor ${agent.executor_type}.`,
          recommended_fix: "Align the assignment executor with the agent registry or choose a different agent."
        })
      );
    }
    if (assignment.executor === "dry_run" && isDeliverableTask(task)) {
      issues.push(
        makeIssue(issues, {
          severity: "high",
          code: "DRY_RUN_DELIVERABLE",
          target: task.task_id,
          message: `Task ${task.task_id} requires a deliverable but is routed to dry_run.`,
          recommended_fix: "Route deliverable tasks to model_agent or local_command; reserve dry_run for packet generation."
        })
      );
    }
    if (agent) {
      addPerformanceRoutingIssues(issues, task, agent, config);
    }
    if (task.risk_level === "high" && !task.review_required) {
      issues.push(
        makeIssue(issues, {
          severity: "high",
          code: "HIGH_RISK_REVIEW_MISSING",
          target: task.task_id,
          message: `High-risk task ${task.task_id} does not require review.`,
          recommended_fix: "Set review_required=true and route an independent reviewer task."
        })
      );
    }
    if (task.risk_level === "high" && task.review_required && reviewerPersonaCount < 3) {
      issues.push(
        makeIssue(issues, {
          severity: "high",
          code: "INSUFFICIENT_REVIEWERS",
          target: task.task_id,
          message: `High-risk reviewable task ${task.task_id} has only ${reviewerPersonaCount} reviewer personas available.`,
          recommended_fix: "Register at least three Reviewer agents with distinct reviewer_persona values before high-risk execution."
        })
      );
    }
    if (hasVagueAcceptanceCriteria(task)) {
      issues.push(
        makeIssue(issues, {
          severity: "medium",
          code: "VAGUE_ACCEPTANCE_CRITERIA",
          target: task.task_id,
          message: `Task ${task.task_id} has vague or weak acceptance criteria.`,
          recommended_fix: "Replace generic criteria with measurable pass/fail checks."
        })
      );
    }
    if (hasUntestableAcceptanceCriteria(task)) {
      issues.push(
        makeIssue(issues, {
          severity: "medium",
          code: "UNTESTABLE_ACCEPTANCE_CRITERIA",
          target: task.task_id,
          message: `Task ${task.task_id} has acceptance criteria that are too vague or subjective to verify.`,
          recommended_fix: "Rewrite each criterion with an observable predicate and concrete evidence target."
        })
      );
    }
    if (task.review_required && !hasDeliverableArtifactSource(task, input.artifactIndex.artifacts)) {
      issues.push(
        makeIssue(issues, {
          severity: "high",
          code: "NO_DELIVERABLE_ARTIFACT",
          target: task.task_id,
          message: `Review-required task ${task.task_id} has no model_output or command_output artifact source for reviewer citations.`,
          recommended_fix: "Route the reviewed task to model_agent or local_command and ensure it emits a citable output artifact."
        })
      );
    }
    if (assignment.executor === "local_command") {
      if (!task.command) {
        issues.push(
          makeIssue(issues, {
            severity: "high",
            code: "LOCAL_COMMAND_MISSING",
            target: task.task_id,
            message: `Local command task ${task.task_id} has no command configured.`,
            recommended_fix: "Add a command spec or choose a non-command executor."
          })
        );
      } else if (agent && !agent.command_allowlist.includes(task.command.command)) {
        issues.push(
          makeIssue(issues, {
            severity: "high",
            code: "LOCAL_COMMAND_NOT_ALLOWLISTED",
            target: `${task.task_id}/${task.command.command}`,
            message: `Command ${task.command.command} is not allowlisted for ${agent.agent_id}.`,
            recommended_fix: "Add the command to the agent allowlist or route to another agent."
          })
        );
      }
    }
    if (isReviewOrSynthesisTask(task)) {
      for (const dependencyId of task.dependencies) {
        const dependency = taskById.get(dependencyId);
        if (
          !dependency ||
          lacksAvailableOrPlannedArtifactSource(
            dependency,
            assignmentByTaskId.get(dependencyId),
            input.artifactIndex.artifacts
          )
        ) {
          issues.push(
            makeIssue(issues, {
              severity: "high",
              code: "REVIEW_DEPENDENCY_ARTIFACT_MISSING",
              target: `${task.task_id}/${dependencyId}`,
              message: `Review/synthesis task ${task.task_id} lacks artifact context from dependency ${dependencyId}.`,
              recommended_fix: "Ensure every dependency produces an indexed artifact before reviewer/synthesizer execution."
            })
          );
        }
      }
    }
  }
  return issues;
}

function lacksAvailableOrPlannedArtifactSource(
  task: Task,
  assignment: DeploymentAssignment | undefined,
  artifacts: Artifact[]
): boolean {
  if (taskArtifacts(task, artifacts).length > 0) return false;
  if (!assignment) return true;
  if (task.status === "completed" || task.status === "approved") return true;
  if (task.status === "failed" || task.status === "blocked") return true;
  return !["model_agent", "local_command", "dry_run"].includes(assignment.executor);
}

function addPerformanceRoutingIssues(
  issues: IntelligenceIssue[],
  task: Task,
  agent: Agent,
  config: ModelConfig
): void {
  const performance = agent.performance;
  if (!performance || performance.tasks_assigned < config.performance_min_assignments) return;

  const reviews = performance.review_passes + performance.review_failures;
  if (task.risk_level === "high" && reviews > 0) {
    const rate = performance.review_passes / reviews;
    if (rate < config.performance_review_pass_floor) {
      issues.push(
        makeIssue(issues, {
          severity: "high",
          code: "LOW_REVIEW_PASS_RATE_FOR_RISK",
          target: `${task.task_id}/${agent.agent_id}`,
          message: `Agent ${agent.agent_id} has review pass rate ${rate.toFixed(2)} (below floor ${config.performance_review_pass_floor}); high-risk task ${task.task_id} should not route here.`,
          recommended_fix:
            "Route the task to an agent with a higher review pass rate or improve the agent's prior review record before assigning high-risk work."
        })
      );
    }
  }

  if (task.risk_level !== "low") {
    const rate = performance.tasks_failed / performance.tasks_assigned;
    if (rate > config.performance_failure_rate_ceiling) {
      issues.push(
        makeIssue(issues, {
          severity: "high",
          code: "HIGH_FAILURE_RATE_AGENT",
          target: `${task.task_id}/${agent.agent_id}`,
          message: `Agent ${agent.agent_id} has failure rate ${rate.toFixed(2)} (above ceiling ${config.performance_failure_rate_ceiling}); ${task.risk_level}-risk task ${task.task_id} should not route here.`,
          recommended_fix:
            "Route the task to an agent with a lower failure history or address the agent's known_failure_modes before assigning non-trivial risk."
        })
      );
    }
  }
}

function hasVagueAcceptanceCriteria(task: Task): boolean {
  if (task.acceptance_criteria.length === 0) return true;
  const vague = new Set(["good", "works", "done", "complete", "quality", "appropriate"]);
  return task.acceptance_criteria.some((criterion) => {
    const normalized = criterion.trim().toLowerCase();
    return normalized.length < 8 || vague.has(normalized);
  });
}

function hasUntestableAcceptanceCriteria(task: Task): boolean {
  if (task.acceptance_criteria.length === 0) return true;
  const vague = new Set(["good", "works", "done", "complete", "quality", "appropriate"]);
  return task.acceptance_criteria.some((criterion) => {
    const normalized = criterion.trim().toLowerCase();
    return normalized.length < 12 || vague.has(normalized) || !/\s/.test(normalized);
  });
}

function hasDeliverableArtifactSource(task: Task, artifacts: Artifact[]): boolean {
  if (task.executor === "model_agent" || task.executor === "local_command") return true;
  return taskArtifacts(task, artifacts).some((artifact) => deliverableArtifactTypes.has(artifact.type));
}
