import { nextId } from "./ids.js";
import {
  ArtifactIndexSchema,
  ContextCheckStoreSchema,
  TaskBoardSchema,
  type ContextCheck,
  type IntelligenceIssue
} from "./schemas.js";
import {
  isDeliverableTask,
  isReadableWorkspacePath,
  isReviewOrSynthesisTask,
  makeIssue,
  pathEscapesWorkspace,
  taskArtifacts,
  transitiveDependencies
} from "./intelligenceCommon.js";
import { loadJson, loadJsonOrDefault, nowIso, saveJson } from "./storage.js";

export async function runContextCheck(root: string, input: { taskId: string }): Promise<ContextCheck> {
  const board = TaskBoardSchema.parse(await loadJson(root, "state/task_board.json"));
  const artifactIndex = ArtifactIndexSchema.parse(await loadJson(root, "artifacts/artifact_index.json"));
  const store = ContextCheckStoreSchema.parse(
    await loadJsonOrDefault(root, "state/context_checks.json", { context_checks: [] })
  );
  const task = board.tasks.find((entry) => entry.task_id === input.taskId);
  if (!task) throw new Error(`Task not found: ${input.taskId}`);
  const issues: IntelligenceIssue[] = [];

  for (const contextPath of task.input_context) {
    if (pathEscapesWorkspace(root, contextPath)) {
      issues.push(
        makeIssue(issues, {
          severity: "high",
          code: "CONTEXT_PATH_ESCAPES_WORKSPACE",
          target: contextPath,
          message: `Context path escapes workspace: ${contextPath}.`,
          recommended_fix: "Use a workspace-relative context path."
        })
      );
    } else if (!(await isReadableWorkspacePath(root, contextPath))) {
      issues.push(
        makeIssue(issues, {
          severity: "high",
          code: "CONTEXT_FILE_MISSING",
          target: contextPath,
          message: `Context file is missing or unreadable: ${contextPath}.`,
          recommended_fix: "Create the context file or remove it from input_context."
        })
      );
    }
  }

  const dependencyTasks = isReviewOrSynthesisTask(task)
    ? transitiveDependencies(task, board.tasks)
    : task.dependencies
        .map((dependencyId) => board.tasks.find((entry) => entry.task_id === dependencyId))
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  for (const dependencyId of task.dependencies) {
    const dependency = board.tasks.find((entry) => entry.task_id === dependencyId);
    if (!dependency) {
      issues.push(
        makeIssue(issues, {
          severity: "high",
          code: "DEPENDENCY_TASK_MISSING",
          target: dependencyId,
          message: `Dependency task does not exist: ${dependencyId}.`,
          recommended_fix: "Create the dependency task or remove it from dependencies."
        })
      );
    } else if (dependency.status !== "completed" && dependency.status !== "approved") {
      issues.push(
        makeIssue(issues, {
          severity: "high",
          code: "DEPENDENCY_NOT_READY",
          target: dependencyId,
          message: `Dependency task ${dependencyId} is ${dependency.status}, not completed or approved.`,
          recommended_fix: "Run or approve dependency outputs before executing this task."
        })
      );
    }
  }

  for (const dependency of dependencyTasks) {
    const artifacts = taskArtifacts(dependency, artifactIndex.artifacts);
    if (artifacts.length === 0) {
      issues.push(
        makeIssue(issues, {
          severity: "high",
          code: "DEPENDENCY_ARTIFACT_MISSING",
          target: dependency.task_id,
          message: `Dependency ${dependency.task_id} has no indexed artifacts.`,
          recommended_fix: "Add a model/command output artifact for the dependency before continuing."
        })
      );
      continue;
    }
    for (const artifact of artifacts) {
      if (!(await isReadableWorkspacePath(root, artifact.path))) {
        issues.push(
          makeIssue(issues, {
            severity: "high",
            code: "DEPENDENCY_ARTIFACT_UNREADABLE",
            target: artifact.artifact_id,
            message: `Dependency artifact ${artifact.artifact_id} is missing or unreadable at ${artifact.path}.`,
            recommended_fix: "Repair the artifact path or regenerate the dependency output."
          })
        );
      }
    }
  }

  const currentTaskArtifacts = taskArtifacts(task, artifactIndex.artifacts);
  if (
    task.status === "completed" &&
    isDeliverableTask(task) &&
    currentTaskArtifacts.length > 0 &&
    currentTaskArtifacts.every((artifact) => artifact.type === "delegation_packet")
  ) {
    issues.push(
      makeIssue(issues, {
        severity: "high",
        code: "DELIVERABLE_ONLY_DELEGATION_PACKET",
        target: task.task_id,
        message: `Completed deliverable task ${task.task_id} only has delegation packet artifacts.`,
        recommended_fix: "Generate a real output artifact for the deliverable."
      })
    );
  }

  const existingIndex = store.context_checks.findIndex((entry) => entry.task_id === task.task_id);
  const existing = existingIndex >= 0 ? store.context_checks[existingIndex] : undefined;
  const check: ContextCheck = {
    check_id:
      existing?.check_id ??
      nextId(
        "CC",
        store.context_checks.map((entry) => entry.check_id)
      ),
    task_id: task.task_id,
    status: issues.length > 0 ? "fail" : "pass",
    issues,
    created_at: existing?.created_at ?? nowIso(),
    updated_at: nowIso()
  };
  if (existingIndex >= 0) store.context_checks[existingIndex] = check;
  else store.context_checks.push(check);
  await saveJson(root, "state/context_checks.json", store);
  return check;
}
