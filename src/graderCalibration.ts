import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// Local Descriptor type. This mirrors GraderDescriptorSchema in src/schemas.ts
// (defined by Unit 1 of the grader subsystem foundation batch). The duplication
// is intentional: this resolver is a leaf utility and must not import from
// src/schemas.ts so that all units in the wave can land independently.
type Descriptor = {
  grader_id: string;
  rubric_version: string;
  model_version: string;
  task_family: string;
  gold_set_version: string;
  prompt_version: string;
  compatibility_tags?: string[];
  [extra: string]: unknown;
};

export type ResolveKey = {
  graderId: string;
  rubricVersion: string;
  modelVersion: string;
  taskFamily: string;
  goldSetVersion: string;
  promptVersion: string;
};

export type ResolveResult = {
  descriptor: Descriptor | null;
  matchLevel: 1 | 2 | 3 | 4 | 5 | 6;
  downgradeToAdvisory: boolean;
  reason: string;
};

const DESCRIPTOR_DIR_RELATIVE = join("state", "grader_descriptors");

/**
 * Resolve a calibration descriptor for the given six-tuple key, walking the
 * fallback hierarchy from spec section 4.5.
 *
 * Implementation note on directory traversal: descriptors are loaded from
 * <root>/state/grader_descriptors/ recursively. Subdirectories are permitted
 * so that operators can group descriptors by grader_id, rubric_version, or any
 * other taxonomy without breaking resolution. Only files ending in ".json"
 * are considered.
 */
export async function resolveDescriptor(root: string, key: ResolveKey): Promise<ResolveResult> {
  const descriptors = await loadAllDescriptors(root);
  const candidates = descriptors.filter((d) => d.grader_id === key.graderId);

  // Level 1: exact match on all six fields.
  const level1 = candidates.find(
    (d) =>
      d.rubric_version === key.rubricVersion &&
      d.model_version === key.modelVersion &&
      d.task_family === key.taskFamily &&
      d.gold_set_version === key.goldSetVersion &&
      d.prompt_version === key.promptVersion
  );
  if (level1) {
    return { descriptor: level1, matchLevel: 1, downgradeToAdvisory: false, reason: "exact_match" };
  }

  // Level 2: match on first five (prompt_version may differ).
  const level2 = candidates.find(
    (d) =>
      d.rubric_version === key.rubricVersion &&
      d.model_version === key.modelVersion &&
      d.task_family === key.taskFamily &&
      d.gold_set_version === key.goldSetVersion
  );
  if (level2) {
    return {
      descriptor: level2,
      matchLevel: 2,
      downgradeToAdvisory: false,
      reason: "prompt_version_merged"
    };
  }

  // Level 3: match on grader_id, rubric_version, model_version, task_family.
  const level3 = candidates.find(
    (d) =>
      d.rubric_version === key.rubricVersion &&
      d.model_version === key.modelVersion &&
      d.task_family === key.taskFamily
  );
  if (level3) {
    return {
      descriptor: level3,
      matchLevel: 3,
      downgradeToAdvisory: false,
      reason: "gold_set_and_prompt_version_merged"
    };
  }

  // Level 4: match on grader_id, rubric_version, model_version when the
  // descriptor's compatibility_tags includes "task_family:" + key.taskFamily.
  const requiredTaskFamilyTag = "task_family:" + key.taskFamily;
  const level4 = candidates.find(
    (d) =>
      d.rubric_version === key.rubricVersion &&
      d.model_version === key.modelVersion &&
      hasCompatibilityTag(d, requiredTaskFamilyTag)
  );
  if (level4) {
    return {
      descriptor: level4,
      matchLevel: 4,
      downgradeToAdvisory: false,
      reason: "task_family_compatible"
    };
  }

  // Level 5: match on grader_id, rubric_version when the descriptor's
  // compatibility_tags includes "model_version:" + key.modelVersion.
  const requiredModelVersionTag = "model_version:" + key.modelVersion;
  const level5 = candidates.find(
    (d) =>
      d.rubric_version === key.rubricVersion &&
      hasCompatibilityTag(d, requiredModelVersionTag)
  );
  if (level5) {
    return {
      descriptor: level5,
      matchLevel: 5,
      downgradeToAdvisory: false,
      reason: "model_version_compatible"
    };
  }

  // Level 6: no match.
  return {
    descriptor: null,
    matchLevel: 6,
    downgradeToAdvisory: true,
    reason: "calibration_unavailable"
  };
}

function hasCompatibilityTag(descriptor: Descriptor, tag: string): boolean {
  const tags = descriptor.compatibility_tags;
  if (!Array.isArray(tags)) return false;
  return tags.includes(tag);
}

async function loadAllDescriptors(root: string): Promise<Descriptor[]> {
  const dir = join(root, DESCRIPTOR_DIR_RELATIVE);
  const files = await listJsonFiles(dir);
  const results = await Promise.all(files.map((filePath) => readDescriptor(filePath)));
  return results.filter((d): d is Descriptor => d !== null);
}

async function listJsonFiles(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw error;
  }

  const collected: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await listJsonFiles(fullPath);
      for (const nestedPath of nested) {
        collected.push(nestedPath);
      }
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) {
      collected.push(fullPath);
    }
  }
  return collected;
}

async function readDescriptor(filePath: string): Promise<Descriptor | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isDescriptorShape(parsed)) return null;
  return parsed;
}

function isDescriptorShape(value: unknown): value is Descriptor {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.grader_id === "string" &&
    typeof v.rubric_version === "string" &&
    typeof v.model_version === "string" &&
    typeof v.task_family === "string" &&
    typeof v.gold_set_version === "string" &&
    typeof v.prompt_version === "string"
  );
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
  );
}
