import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { createCli } from "../src/cli.js";
import { saveJson } from "../src/storage.js";
import { initWorkspace } from "../src/workspace.js";

async function withWorkspace<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "maw-grader-cli-test-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

interface CliResult {
  stdout: string;
  error?: unknown;
}

async function runCli(root: string, args: string[]): Promise<CliResult> {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((message?: unknown, ...rest: unknown[]) => {
    lines.push([message, ...rest].map((entry) => String(entry)).join(" "));
  });
  const errSpy = vi.spyOn(console, "error").mockImplementation((message?: unknown, ...rest: unknown[]) => {
    lines.push([message, ...rest].map((entry) => String(entry)).join(" "));
  });
  const program = createCli(root);
  program.exitOverride();
  program.configureOutput({
    writeOut: (value) => lines.push(value.endsWith("\n") ? value.slice(0, -1) : value),
    writeErr: (value) => lines.push(value.endsWith("\n") ? value.slice(0, -1) : value)
  });
  let caught: unknown;
  try {
    await program.parseAsync(["node", "maw", ...args], { from: "node" });
  } catch (error) {
    caught = error;
  } finally {
    log.mockRestore();
    errSpy.mockRestore();
    process.exitCode = undefined;
  }
  const stdout = lines.length === 0 ? "" : lines.join("\n") + "\n";
  return caught === undefined ? { stdout } : { stdout, error: caught };
}

describe("maw grader status", () => {
  test("prints No graders registered when registry is empty", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await saveJson(root, "state/grader_registry.json", { entries: [] });
      const result = await runCli(root, ["grader", "status"]);
      expect(result.error).toBeUndefined();
      expect(result.stdout).toContain("No graders registered.");
    });
  });

  test("treats a missing registry file as empty", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const result = await runCli(root, ["grader", "status"]);
      expect(result.error).toBeUndefined();
      expect(result.stdout).toContain("No graders registered.");
    });
  });

  test("prints one line per registered grader", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await saveJson(root, "state/grader_registry.json", {
        entries: [
          {
            grader_id: "reviewer_calibration",
            current_descriptor_id: "GD-RC-001",
            enforcement_state: "calibrating"
          },
          {
            grader_id: "acceptance_criteria",
            current_descriptor_id: "GD-AC-001",
            enforcement_state: "observation_shadow",
            last_audit_at: "2026-05-08T00:00:00.000Z"
          },
          {
            grader_id: "intent",
            current_descriptor_id: "GD-INT-001",
            enforcement_state: "action_reversal_shadow"
          }
        ]
      });
      const result = await runCli(root, ["grader", "status"]);
      expect(result.error).toBeUndefined();
      expect(result.stdout).toContain(
        "reviewer_calibration descriptor=GD-RC-001 state=calibrating last_audit=never"
      );
      expect(result.stdout).toContain(
        "acceptance_criteria descriptor=GD-AC-001 state=observation_shadow last_audit=2026-05-08T00:00:00.000Z"
      );
      expect(result.stdout).toContain(
        "intent descriptor=GD-INT-001 state=action_reversal_shadow last_audit=never"
      );
    });
  });
});

describe("maw grader audit", () => {
  test("prints the expected JSON shape with --json", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await saveJson(root, "state/grader_registry.json", {
        entries: [
          {
            grader_id: "reviewer_calibration",
            current_descriptor_id: "GD-RC-001",
            enforcement_state: "calibrating"
          },
          {
            grader_id: "acceptance_criteria",
            current_descriptor_id: "GD-AC-001",
            enforcement_state: "observation_shadow"
          },
          {
            grader_id: "intent",
            current_descriptor_id: "GD-INT-001",
            enforcement_state: "calibrating"
          }
        ]
      });
      const result = await runCli(root, ["grader", "audit", "--json"]);
      expect(result.error).toBeUndefined();
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed).toEqual({
        total: 3,
        by_state: {
          calibrating: 2,
          observation_shadow: 1
        }
      });
    });
  });

  test("prints zero totals when registry missing", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const result = await runCli(root, ["grader", "audit", "--json"]);
      expect(result.error).toBeUndefined();
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed).toEqual({ total: 0, by_state: {} });
    });
  });

  test("prints human-readable summary by default", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await saveJson(root, "state/grader_registry.json", {
        entries: [
          {
            grader_id: "intent",
            current_descriptor_id: "GD-INT-001",
            enforcement_state: "calibrating"
          }
        ]
      });
      const result = await runCli(root, ["grader", "audit"]);
      expect(result.error).toBeUndefined();
      expect(result.stdout).toContain("Total registered graders: 1");
      expect(result.stdout).toContain("- calibrating: 1");
    });
  });
});

describe("maw grader list-outputs", () => {
  test("lists the most recent outputs sorted by mtime descending", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const dir = join(root, "state", "grader_outputs", "acceptance_criteria");
      await mkdir(dir, { recursive: true });
      const files = [
        { name: "GO-AC-001.json", id: "GO-AC-001", created: "2026-05-01T00:00:00.000Z", mtime: 1000 },
        { name: "GO-AC-002.json", id: "GO-AC-002", created: "2026-05-02T00:00:00.000Z", mtime: 2000 },
        { name: "GO-AC-003.json", id: "GO-AC-003", created: "2026-05-03T00:00:00.000Z", mtime: 3000 }
      ];
      for (const file of files) {
        const filePath = join(dir, file.name);
        await writeFile(
          filePath,
          JSON.stringify({
            grader_output_id: file.id,
            grader: "acceptance_criteria",
            created_at: file.created
          }),
          "utf8"
        );
      }
      for (const file of files) {
        const filePath = join(dir, file.name);
        await utimes(filePath, file.mtime, file.mtime);
      }

      const result = await runCli(root, [
        "grader",
        "list-outputs",
        "--grader",
        "acceptance_criteria"
      ]);
      expect(result.error).toBeUndefined();
      expect(result.stdout).toContain("GO-AC-001.json");
      expect(result.stdout).toContain("GO-AC-002.json");
      expect(result.stdout).toContain("GO-AC-003.json");
      expect(result.stdout).toContain("grader_output_id=GO-AC-003");
      const idx1 = result.stdout.indexOf("GO-AC-003.json");
      const idx2 = result.stdout.indexOf("GO-AC-002.json");
      const idx3 = result.stdout.indexOf("GO-AC-001.json");
      expect(idx1).toBeGreaterThanOrEqual(0);
      expect(idx1).toBeLessThan(idx2);
      expect(idx2).toBeLessThan(idx3);
    });
  });

  test("prints a friendly notice when the grader output directory is missing", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const result = await runCli(root, [
        "grader",
        "list-outputs",
        "--grader",
        "acceptance_criteria"
      ]);
      expect(result.error).toBeUndefined();
      expect(result.stdout).toContain("No outputs found for grader acceptance_criteria.");
    });
  });

  test("rejects unknown grader ids with a clear error", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const result = await runCli(root, ["grader", "list-outputs", "--grader", "unknown_id"]);
      expect(result.error).toBeDefined();
      expect(String(result.error)).toContain("Unknown grader id unknown_id");
    });
  });
});
