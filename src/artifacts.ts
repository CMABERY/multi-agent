import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ArtifactIndexSchema, TaskBoardSchema, type Artifact } from "./schemas.js";
import { nextId } from "./ids.js";
import { loadJson, nowIso, saveJson } from "./storage.js";

export async function addArtifact(
  root: string,
  input: {
    taskId: string;
    path: string;
    type: string;
    description: string;
  }
): Promise<Artifact> {
  const index = ArtifactIndexSchema.parse(await loadJson(root, "artifacts/artifact_index.json"));
  const artifact: Artifact = {
    artifact_id: nextId(
      "ART",
      index.artifacts.map((entry) => entry.artifact_id)
    ),
    task_id: input.taskId,
    path: input.path,
    type: input.type,
    description: input.description,
    created_at: nowIso()
  };
  index.artifacts.push(artifact);
  await saveJson(root, "artifacts/artifact_index.json", index);

  const board = TaskBoardSchema.parse(await loadJson(root, "state/task_board.json"));
  const task = board.tasks.find((entry) => entry.task_id === input.taskId);
  if (task && !task.artifacts.includes(artifact.artifact_id)) {
    task.artifacts.push(artifact.artifact_id);
    task.updated_at = nowIso();
    await saveJson(root, "state/task_board.json", board);
  }
  return artifact;
}

export async function ensureRunDir(root: string, taskId: string): Promise<string> {
  const relative = `artifacts/runs/${taskId}`;
  await mkdir(join(root, relative), { recursive: true });
  return relative;
}
