import { access } from "node:fs/promises";
import { join, normalize, relative, resolve, sep } from "node:path";
import { nextId } from "./ids.js";
import {
  AgentRegistrySchema,
  ArtifactIndexSchema,
  DeploymentPlanStoreSchema,
  TaskBoardSchema,
  type Artifact,
  type DeploymentPlan,
  type IntelligenceIssue,
  type Task
} from "./schemas.js";
import { loadJson, nowIso } from "./storage.js";

export async function loadDeploymentContext(root: string, deploymentId: string) {
  const plans = DeploymentPlanStoreSchema.parse(await loadJson(root, "state/deployment_plan.json"));
  const plan = plans.deployment_plans.find((entry) => entry.deployment_id === deploymentId);
  if (!plan) throw new Error(`Deployment not found: ${deploymentId}`);
  const board = TaskBoardSchema.parse(await loadJson(root, "state/task_board.json"));
  const registry = AgentRegistrySchema.parse(await loadJson(root, "state/agent_registry.json"));
  const artifactIndex = ArtifactIndexSchema.parse(await loadJson(root, "artifacts/artifact_index.json"));
  const taskIds = new Set(plan.assignments.map((assignment) => assignment.task_id));
  const tasks = board.tasks.filter(
    (task) => taskIds.has(task.task_id) || task.deployment_id === plan.deployment_id
  );
  return { plan, board, registry, artifactIndex, tasks };
}

export function isDeliverableTask(task: Task): boolean {
  const output = task.output_required.toLowerCase();
  return !output.includes("delegation packet") && !output.includes("task packet");
}

export function isReviewOrSynthesisTask(task: Task): boolean {
  const haystack = `${task.title} ${task.owner_role} ${task.output_required}`.toLowerCase();
  return (
    haystack.includes("review") ||
    haystack.includes("synthes") ||
    haystack.includes("final") ||
    haystack.includes("integrat")
  );
}

export function taskArtifacts(task: Task, artifacts: Artifact[]): Artifact[] {
  const artifactIds = new Set(task.artifacts);
  return artifacts.filter(
    (artifact) => artifact.task_id === task.task_id || artifactIds.has(artifact.artifact_id)
  );
}

export function makeIssue(
  existingIssues: IntelligenceIssue[],
  input: Omit<IntelligenceIssue, "issue_id" | "created_at">
): IntelligenceIssue {
  return {
    issue_id: nextId(
      input.code.startsWith("CONTEXT") || input.code.startsWith("DEPENDENCY") ? "CCI" : "PCI",
      existingIssues.map((issue) => issue.issue_id)
    ),
    created_at: nowIso(),
    ...input
  };
}

export function pathEscapesWorkspace(root: string, relativePath: string): boolean {
  const absolute = resolve(root, normalize(relativePath));
  const workspace = resolve(root);
  const pathRelativeToRoot = relative(workspace, absolute);
  return pathRelativeToRoot === ".." || pathRelativeToRoot.startsWith(`..${sep}`);
}

export async function isReadableWorkspacePath(root: string, relativePath: string): Promise<boolean> {
  if (pathEscapesWorkspace(root, relativePath)) return false;
  try {
    await access(join(root, relativePath));
    return true;
  } catch {
    return false;
  }
}

export function transitiveDependencies(task: Task, allTasks: Task[]): Task[] {
  const byId = new Map(allTasks.map((entry) => [entry.task_id, entry]));
  const visited = new Set<string>();
  const result: Task[] = [];

  function visit(taskId: string): void {
    if (visited.has(taskId)) return;
    visited.add(taskId);
    const dependency = byId.get(taskId);
    if (!dependency) return;
    for (const next of dependency.dependencies) visit(next);
    result.push(dependency);
  }

  for (const dependency of task.dependencies) visit(dependency);
  return result;
}

export function deploymentTaskIds(plan: DeploymentPlan): Set<string> {
  return new Set(plan.assignments.map((assignment) => assignment.task_id));
}
