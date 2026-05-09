import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { initWorkspace } from "../src/workspace.js";

async function withWorkspace<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "maw-workspace-test-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("initWorkspace grader scaffolding", () => {
  test("creates the eight grader-related directories", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const expectedDirs = [
        "state/grader_descriptors",
        "state/grader_outputs/reviewer_calibration",
        "state/grader_outputs/acceptance_criteria",
        "state/grader_outputs/intent",
        "state/grader_outputs/review_reasoning",
        "state/grader_outputs/output_quality",
        "state/calibration",
        "state/probation"
      ];
      for (const dir of expectedDirs) {
        expect(await exists(join(root, dir))).toBe(true);
      }
    });
  });

  test("creates the two grader default JSON files with empty-shell content", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);

      const registryRaw = await readFile(join(root, "state/grader_registry.json"), "utf8");
      expect(JSON.parse(registryRaw)).toEqual({ entries: [] });

      const probationRaw = await readFile(
        join(root, "state/probation/probation_log.json"),
        "utf8"
      );
      expect(JSON.parse(probationRaw)).toEqual({ records: [] });
    });
  });

  test("re-running initWorkspace does not overwrite existing grader JSON files", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const registryPath = join(root, "state/grader_registry.json");
      const probationPath = join(root, "state/probation/probation_log.json");
      const seededRegistry = JSON.stringify({ entries: [{ grader_id: "g1" }] }, null, 2);
      const seededProbation = JSON.stringify({ records: [{ reviewer_id: "r1" }] }, null, 2);
      await writeFile(registryPath, seededRegistry, "utf8");
      await writeFile(probationPath, seededProbation, "utf8");

      await initWorkspace(root);

      expect(await readFile(registryPath, "utf8")).toBe(seededRegistry);
      expect(await readFile(probationPath, "utf8")).toBe(seededProbation);
    });
  });
});

