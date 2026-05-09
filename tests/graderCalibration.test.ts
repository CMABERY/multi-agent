import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { resolveDescriptor } from "../src/graderCalibration.js";
import { saveJson } from "../src/storage.js";

async function withWorkspace<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "maw-grader-calibration-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

type DescriptorOverrides = {
  grader_id?: string;
  rubric_version?: string;
  model_version?: string;
  task_family?: string;
  gold_set_version?: string;
  prompt_version?: string;
  compatibility_tags?: string[];
};

function makeDescriptor(overrides: DescriptorOverrides = {}): Record<string, unknown> {
  return {
    grader_id: overrides.grader_id ?? "reviewer_calibration",
    rubric_version: overrides.rubric_version ?? "rubric_v1",
    model_version: overrides.model_version ?? "model_v1",
    task_family: overrides.task_family ?? "code_review",
    gold_set_version: overrides.gold_set_version ?? "gold_v1",
    prompt_version: overrides.prompt_version ?? "prompt_v1",
    compatibility_tags: overrides.compatibility_tags ?? []
  };
}

const DESCRIPTOR_DIR = join("state", "grader_descriptors");

const baseKey = {
  graderId: "reviewer_calibration",
  rubricVersion: "rubric_v1",
  modelVersion: "model_v1",
  taskFamily: "code_review",
  goldSetVersion: "gold_v1",
  promptVersion: "prompt_v1"
};

describe("resolveDescriptor (six-tuple fallback hierarchy)", () => {
  test("level 1: exact match on all six fields", async () => {
    await withWorkspace(async (root) => {
      await saveJson(root, join(DESCRIPTOR_DIR, "exact.json"), makeDescriptor());

      const result = await resolveDescriptor(root, baseKey);

      expect(result.matchLevel).toBe(1);
      expect(result.downgradeToAdvisory).toBe(false);
      expect(result.descriptor).not.toBeNull();
      expect(result.descriptor?.prompt_version).toBe("prompt_v1");
    });
  });

  test("level 2: prompt_version differs but other five match", async () => {
    await withWorkspace(async (root) => {
      await saveJson(
        root,
        join(DESCRIPTOR_DIR, "level2.json"),
        makeDescriptor({ prompt_version: "prompt_other" })
      );

      const result = await resolveDescriptor(root, baseKey);

      expect(result.matchLevel).toBe(2);
      expect(result.downgradeToAdvisory).toBe(false);
      expect(result.descriptor?.prompt_version).toBe("prompt_other");
    });
  });

  test("level 3: gold_set_version and prompt_version differ", async () => {
    await withWorkspace(async (root) => {
      await saveJson(
        root,
        join(DESCRIPTOR_DIR, "level3.json"),
        makeDescriptor({
          gold_set_version: "gold_other",
          prompt_version: "prompt_other"
        })
      );

      const result = await resolveDescriptor(root, baseKey);

      expect(result.matchLevel).toBe(3);
      expect(result.downgradeToAdvisory).toBe(false);
      expect(result.descriptor?.gold_set_version).toBe("gold_other");
    });
  });

  test("level 4: task_family differs but compatibility tag is set", async () => {
    await withWorkspace(async (root) => {
      await saveJson(
        root,
        join(DESCRIPTOR_DIR, "level4.json"),
        makeDescriptor({
          task_family: "other_family",
          gold_set_version: "gold_other",
          prompt_version: "prompt_other",
          compatibility_tags: ["task_family:code_review"]
        })
      );

      const result = await resolveDescriptor(root, baseKey);

      expect(result.matchLevel).toBe(4);
      expect(result.downgradeToAdvisory).toBe(false);
      expect(result.descriptor?.task_family).toBe("other_family");
    });
  });

  test("level 4 does NOT match without explicit task_family compatibility tag", async () => {
    await withWorkspace(async (root) => {
      await saveJson(
        root,
        join(DESCRIPTOR_DIR, "no-tag.json"),
        makeDescriptor({
          task_family: "other_family",
          gold_set_version: "gold_other",
          prompt_version: "prompt_other",
          compatibility_tags: ["unrelated:tag"]
        })
      );

      const result = await resolveDescriptor(root, baseKey);

      expect(result.matchLevel).toBe(6);
      expect(result.descriptor).toBeNull();
      expect(result.downgradeToAdvisory).toBe(true);
    });
  });

  test("level 5: model_version differs but compatibility tag is set", async () => {
    await withWorkspace(async (root) => {
      await saveJson(
        root,
        join(DESCRIPTOR_DIR, "level5.json"),
        makeDescriptor({
          model_version: "model_other",
          task_family: "other_family",
          gold_set_version: "gold_other",
          prompt_version: "prompt_other",
          compatibility_tags: ["model_version:model_v1"]
        })
      );

      const result = await resolveDescriptor(root, baseKey);

      expect(result.matchLevel).toBe(5);
      expect(result.downgradeToAdvisory).toBe(false);
      expect(result.descriptor?.model_version).toBe("model_other");
    });
  });

  test("level 5 does NOT match without explicit model_version compatibility tag", async () => {
    await withWorkspace(async (root) => {
      await saveJson(
        root,
        join(DESCRIPTOR_DIR, "no-model-tag.json"),
        makeDescriptor({
          model_version: "model_other",
          task_family: "other_family",
          gold_set_version: "gold_other",
          prompt_version: "prompt_other",
          compatibility_tags: ["task_family:something_else"]
        })
      );

      const result = await resolveDescriptor(root, baseKey);

      expect(result.matchLevel).toBe(6);
      expect(result.descriptor).toBeNull();
      expect(result.downgradeToAdvisory).toBe(true);
    });
  });

  test("level 6: no descriptors at all returns null and downgrades to advisory", async () => {
    await withWorkspace(async (root) => {
      const result = await resolveDescriptor(root, baseKey);

      expect(result.matchLevel).toBe(6);
      expect(result.descriptor).toBeNull();
      expect(result.downgradeToAdvisory).toBe(true);
      expect(result.reason).toBe("calibration_unavailable");
    });
  });

  test("level 6: descriptors exist but grader_id does not match", async () => {
    await withWorkspace(async (root) => {
      await saveJson(
        root,
        join(DESCRIPTOR_DIR, "other-grader.json"),
        makeDescriptor({ grader_id: "intent_grader" })
      );

      const result = await resolveDescriptor(root, baseKey);

      expect(result.matchLevel).toBe(6);
      expect(result.descriptor).toBeNull();
      expect(result.downgradeToAdvisory).toBe(true);
    });
  });

  test("higher-priority match wins when both level 1 and level 2 candidates exist", async () => {
    await withWorkspace(async (root) => {
      await saveJson(
        root,
        join(DESCRIPTOR_DIR, "level2.json"),
        makeDescriptor({ prompt_version: "prompt_other" })
      );
      await saveJson(root, join(DESCRIPTOR_DIR, "level1.json"), makeDescriptor());

      const result = await resolveDescriptor(root, baseKey);

      expect(result.matchLevel).toBe(1);
      expect(result.descriptor?.prompt_version).toBe("prompt_v1");
    });
  });

  test("descriptors in nested subdirectories are discovered", async () => {
    await withWorkspace(async (root) => {
      await saveJson(
        root,
        join(DESCRIPTOR_DIR, "reviewer_calibration", "rubric_v1", "exact.json"),
        makeDescriptor()
      );

      const result = await resolveDescriptor(root, baseKey);

      expect(result.matchLevel).toBe(1);
      expect(result.descriptor).not.toBeNull();
    });
  });
});
