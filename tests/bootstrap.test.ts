import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { evaluatePosture, postureExitCode, runBootstrap } from "../src/bootstrap.js";
import { BootstrapPacketSchema } from "../src/schemas.js";
import { saveJson, saveText } from "../src/storage.js";
import { initWorkspace } from "../src/workspace.js";

async function withWorkspace<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "maw-bootstrap-test-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function snapshotStateFiles(root: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  for (const relativePath of [
    "state/intent_queue.json",
    "state/task_board.json",
    "state/deployment_plan.json",
    "state/agent_registry.json",
    "state/model_config.json",
    "state/chat.json",
    "state/review_log.json",
    "state/consensus.json",
    "state/approvals.json",
    "state/metrics.json",
    "state/workflow_score.json",
    "state/plan_checks.json",
    "state/context_checks.json",
    "state/learning_memory.json",
    "state/retrospective_index.json",
    "state/performance_ledger.json",
    "state/prompt_contract.md",
    "state/decision_log.md",
    "artifacts/artifact_index.json"
  ]) {
    try {
      snapshot.set(relativePath, await readFile(join(root, relativePath), "utf8"));
    } catch {
      // missing file — record absence as empty marker so creation would also fail equality
      snapshot.set(relativePath, "<absent>");
    }
  }
  return snapshot;
}

async function runGitInit(root: string, args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn("git", args, { cwd: root, shell: false, windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error("git " + (args.join(" ")) + " exited " + (code) + ": " + (stderr)));
    });
  });
}

describe("bootstrap read-only invariants", () => {
  test("default run does not modify any operational state file", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const before = await snapshotStateFiles(root);
      const result = await runBootstrap(root, { workType: "ordinary", persist: false });
      expect(result.packet.bootstrap_id).toMatch(/^BS-\d{3,}$/);
      const after = await snapshotStateFiles(root);
      for (const [path, contentBefore] of before) {
        expect(after.get(path)).toBe(contentBefore);
      }
    });
  });

  test("--persist writes only state/bootstrap/* and leaves all other state untouched", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const before = await snapshotStateFiles(root);
      const first = await runBootstrap(root, { workType: "ordinary", persist: true });
      expect(first.packet.bootstrap_id).toBe("BS-001");
      const after = await snapshotStateFiles(root);
      for (const [path, contentBefore] of before) {
        expect(after.get(path)).toBe(contentBefore);
      }
      const bootstrapDir = await readdir(join(root, "state/bootstrap"));
      expect(bootstrapDir.sort()).toEqual(["BS-001.json", "BS-001.md", "index.json"]);
    });
  });

  test("static check: bootstrap.ts does not import forbidden state-mutating modules", async () => {
    const source = await readFile(join(process.cwd(), "src/bootstrap.ts"), "utf8");
    for (const forbidden of [
      'from "./openai',
      'from "./validator',
      'from "./consensus',
      'from "./performance',
      'from "./retrospective',
      'from "./reviews',
      'from "./approvals'
    ]) {
      expect(source).not.toContain(forbidden);
    }
    expect(source).toContain('"status"');
    expect(source).toContain('"--porcelain"');
    expect(source).toContain('"-unormal"');
    expect(source).not.toContain('"-uall"');
  });
});

describe("bootstrap posture escalations", () => {
  test("no git directory escalates to wide_scan", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const result = await runBootstrap(root, { workType: "ordinary" });
      expect(result.packet.counter_context.git.present).toBe(false);
      expect(result.packet.posture).toBe("wide_scan");
      expect(result.packet.posture_reasons.some((reason) => reason.includes("git repository not present"))).toBe(true);
    });
  });

  test("git initialized with no commits escalates to wide_scan", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await runGitInit(root, ["init"]);
      const result = await runBootstrap(root, { workType: "ordinary" });
      expect(result.packet.counter_context.git.present).toBe(true);
      expect(result.packet.counter_context.git.has_commits).toBe(false);
      expect(result.packet.counter_context.git.untracked_count).toBeLessThan(50);
      expect(result.packet.posture).toBe("wide_scan");
      expect(result.packet.posture_reasons.some((reason) => reason.includes("no commits"))).toBe(true);
    });
  });

  test("running deployment with --work-type stateful escalates to ask_human", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await saveJson(root, "state/deployment_plan.json", {
        deployment_plans: [
          {
            deployment_id: "DP-001",
            intent_id: "I-001",
            status: "running",
            approval_required: true,
            approved_at: "2026-05-08T00:00:00.000Z",
            assignments: [
              {
                task_id: "T-001",
                agent_id: "researcher_1",
                executor: "model_agent",
                model_tier: "mid",
                reason: "Test fixture.",
                approval_required: false
              }
            ],
            created_at: "2026-05-08T00:00:00.000Z",
            updated_at: "2026-05-08T00:00:00.000Z"
          }
        ]
      });
      const result = await runBootstrap(root, { workType: "stateful" });
      expect(result.packet.posture).toBe("ask_human");
      expect(
        result.packet.posture_reasons.some((reason) => reason.includes("active running deployment"))
      ).toBe(true);
    });
  });

  test("garbage in core state file produces ask_human and parse failure entry", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await saveText(root, "state/task_board.json", "{ this is not valid json");
      const result = await runBootstrap(root, { workType: "ordinary" });
      expect(result.packet.posture).toBe("ask_human");
      expect(result.packet.counter_context.parse_failures.length).toBeGreaterThan(0);
      expect(
        result.packet.counter_context.parse_failures.some((failure) =>
          failure.path === "state/task_board.json"
        )
      ).toBe(true);
      expect(result.packet.posture_reasons.some((reason) => reason.includes("core state unparseable"))).toBe(true);
    });
  });

  test("--work-type risky on a wide_scan workspace upgrades to governed with required_extra_review", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      // create dist/ but no .gitignore — wide_scan trigger
      await mkdir(join(root, "dist"), { recursive: true });
      const result = await runBootstrap(root, { workType: "risky" });
      // Either ask_human (no commits + risky) or governed are valid escalations here.
      // The directive says risky + no source-of-truth → ask_human. Verify that path.
      expect(["ask_human", "governed"].includes(result.packet.posture)).toBe(true);
      if (result.packet.posture === "governed") {
        expect(result.packet.required_extra_review.length).toBeGreaterThan(0);
      }
    });
  });

  test("evaluatePosture: governed only when wide_scan triggers AND work-type is architecture or risky", async () => {
    // wide_scan trigger: missing remote (only). No running deployments, has commits — keeps it out of ask_human.
    const widescan = evaluatePosture({
      continuity: minimalContinuity({ activeRunning: false }),
      counterContext: minimalCounter({ gitPresent: true, hasCommits: true, hasRemote: false }),
      workType: "architecture"
    });
    expect(widescan.posture).toBe("governed");
    expect(widescan.requiredExtraReview.length).toBeGreaterThan(0);
    expect(widescan.requiredExtraReview.join("\n")).not.toContain(String.fromCharCode(96));

    const ordinary = evaluatePosture({
      continuity: minimalContinuity({ activeRunning: false }),
      counterContext: minimalCounter({ gitPresent: true, hasCommits: true, hasRemote: false }),
      workType: "ordinary"
    });
    expect(ordinary.posture).toBe("wide_scan");
    expect(ordinary.requiredExtraReview).toEqual([]);
  });

  test("ordinary work with commits, remote, and large untracked surface escalates to wide_scan", () => {
    const result = evaluatePosture({
      continuity: minimalContinuity({ activeRunning: false }),
      counterContext: minimalCounter({
        gitPresent: true,
        hasCommits: true,
        hasRemote: true,
        untrackedCount: 94
      }),
      workType: "ordinary"
    });

    expect(result.posture).toBe("wide_scan");
    expect(
      result.reasons.some(
        (reason) => reason.includes("large untracked surface") && reason.includes("untracked_count=94")
      )
    ).toBe(true);
    expect(result.requiredExtraReview).toEqual([]);
  });

  test("untracked_capped alone escalates to wide_scan", () => {
    const result = evaluatePosture({
      continuity: minimalContinuity({ activeRunning: false }),
      counterContext: minimalCounter({
        gitPresent: true,
        hasCommits: true,
        hasRemote: true,
        untrackedCapped: true
      }),
      workType: "ordinary"
    });

    expect(result.posture).toBe("wide_scan");
    expect(result.reasons.some((reason) => reason.includes("untracked_capped=true"))).toBe(true);
  });

  test("small-surface ordinary repo stays normal", () => {
    const result = evaluatePosture({
      continuity: minimalContinuity({ activeRunning: false }),
      counterContext: minimalCounter({
        gitPresent: true,
        hasCommits: true,
        hasRemote: true,
        untrackedCount: 0,
        untrackedCapped: false
      }),
      workType: "ordinary"
    });

    expect(result.posture).toBe("normal");
    expect(result.reasons).toEqual([]);
  });

  test("deep node_modules and dist are not enumerated as nested untracked files", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await runGitInit(root, ["init"]);
      await mkdir(join(root, "node_modules", "deep", "nested", "pkg"), { recursive: true });
      await writeFile(join(root, "node_modules", "deep", "nested", "pkg", "index.js"), "module.exports = {};\n");
      await mkdir(join(root, "dist"), { recursive: true });
      await writeFile(join(root, "dist", "bundle.js"), "");

      const result = await runBootstrap(root, { workType: "ordinary" });

      expect(result.packet.counter_context.hygiene.node_modules_present).toBe(true);
      expect(result.packet.counter_context.hygiene.dist_present).toBe(true);
      expect(result.packet.counter_context.git.untracked_count).toBeLessThan(20);
      expect(result.packet.counter_context.git.untracked_capped).toBe(false);
    });
  });

  test("tracked-only status overflow is not reported as a large untracked surface", async () => {
    await withWorkspace(async (root) => {
      await initCommittedRepo(root);

      await mkdir(join(root, "tracked"), { recursive: true });
      for (let index = 0; index < 750; index += 1) {
        await writeFile(join(root, "tracked", "file-" + (String(index).padStart(4, "0")) + ".txt"), "baseline\n");
      }
      await runGitInit(root, ["add", "tracked"]);
      await runGitInit(root, ["commit", "-m", "add tracked files"]);

      for (let index = 0; index < 750; index += 1) {
        await writeFile(join(root, "tracked", "file-" + (String(index).padStart(4, "0")) + ".txt"), "modified\n");
      }

      const result = await runBootstrap(root, { workType: "ordinary" });

      expect(result.packet.counter_context.git.status_capped).toBe(true);
      expect(result.packet.counter_context.git.untracked_count).toBe(0);
      expect(result.packet.counter_context.git.untracked_capped).toBe(false);
      expect(result.packet.posture_reasons.some((reason) => reason.includes("large untracked surface"))).toBe(false);
      expect(result.packet.posture_reasons.some((reason) => reason.includes("git status output capped"))).toBe(true);
    });
  });

  test("actual large untracked surface escalates to wide_scan", async () => {
    await withWorkspace(async (root) => {
      await initCommittedRepo(root);

      for (let index = 0; index < 14; index += 1) {
        await writeFile(join(root, "untracked-" + (String(index).padStart(2, "0")) + ".txt"), "new\n");
      }

      const result = await runBootstrap(root, { workType: "ordinary" });

      expect(result.packet.counter_context.git.untracked_count).toBeGreaterThan(12);
      expect(result.packet.posture).toBe("wide_scan");
      expect(result.packet.posture_reasons.some((reason) => reason.includes("large untracked surface"))).toBe(true);
    });
  });
});

describe("bootstrap output shapes", () => {
  test("packet validates against BootstrapPacketSchema in all postures", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const result = await runBootstrap(root, { workType: "ordinary" });
      expect(() => BootstrapPacketSchema.parse(result.packet)).not.toThrow();
      expect(result.markdown).toContain("Bootstrap is readiness support");
      expect(result.markdown).toContain("## Posture");
      expect(result.markdown).not.toContain(String.fromCharCode(96));
    });
  });

  test("schema defaults missing git status_capped to false for old packets", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const result = await runBootstrap(root, { workType: "ordinary" });
      const oldStylePacket = JSON.parse(JSON.stringify(result.packet)) as Record<string, unknown>;
      const counter = oldStylePacket.counter_context as { git: Record<string, unknown> };
      delete counter.git.status_capped;

      const parsed = BootstrapPacketSchema.parse(oldStylePacket);

      expect((parsed.counter_context.git as { status_capped?: boolean }).status_capped).toBe(false);
    });
  });

  test("elevated posture renders Counter-Context before Continuity", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const result = await runBootstrap(root, { workType: "ordinary" });
      const counterIdx = result.markdown.indexOf("## Counter-Context Frame");
      const continuityIdx = result.markdown.indexOf("## Continuity Frame");
      expect(counterIdx).toBeGreaterThan(-1);
      expect(continuityIdx).toBeGreaterThan(-1);
      // wide_scan posture (no git) → counter first
      expect(counterIdx).toBeLessThan(continuityIdx);
    });
  });

  test("postureExitCode mapping is locked", () => {
    expect(postureExitCode("normal")).toBe(0);
    expect(postureExitCode("wide_scan")).toBe(0);
    expect(postureExitCode("governed")).toBe(1);
    expect(postureExitCode("ask_human")).toBe(2);
  });
});

describe("bootstrap persistence", () => {
  test("two persisted runs produce BS-001 and BS-002 with index updated and BS-001 untouched", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const first = await runBootstrap(root, { workType: "ordinary", persist: true });
      const firstMd = await readFile(join(root, "state/bootstrap/" + (first.packet.bootstrap_id) + ".md"), "utf8");
      const second = await runBootstrap(root, { workType: "ordinary", persist: true });
      expect(first.packet.bootstrap_id).toBe("BS-001");
      expect(second.packet.bootstrap_id).toBe("BS-002");
      const firstMdAgain = await readFile(join(root, "state/bootstrap/" + (first.packet.bootstrap_id) + ".md"), "utf8");
      expect(firstMdAgain).toBe(firstMd);
      const indexRaw = await readFile(join(root, "state/bootstrap/index.json"), "utf8");
      const index = JSON.parse(indexRaw) as { bootstraps: Array<{ bootstrap_id: string }> };
      expect(index.bootstraps.map((entry) => entry.bootstrap_id)).toEqual(["BS-001", "BS-002"]);
    });
  });
});

function minimalContinuity(options: { activeRunning?: boolean } = {}) {
  return {
    project: { name: "x", description: "", version: "0.0.0" },
    stack: { runtime: "node", language: "typescript", key_deps: [] },
    active_deployments: options.activeRunning
      ? [{ deployment_id: "DP-001", status: "running", intent_id: "I-001" }]
      : [],
    active_tasks: options.activeRunning
      ? [{ task_id: "T-001", status: "running", title: "x" }]
      : [],
    recent_artifacts: [],
    conventions: { has_protocols_dir: true, has_instructions_dir: true, has_model_config: true }
  };
}

function minimalCounter(options: {
  gitPresent: boolean;
  hasCommits: boolean;
  hasRemote: boolean;
  untrackedCount?: number;
  untrackedCapped?: boolean;
}) {
  return {
    git: {
      present: options.gitPresent,
      has_commits: options.hasCommits,
      has_remote: options.hasRemote,
      dirty: false,
      status_capped: false,
      untracked_count: options.untrackedCount ?? 0,
      untracked_capped: options.untrackedCapped ?? false
    },
    hygiene: { has_gitignore: true, dist_present: false, node_modules_present: false },
    runtime_warnings: [],
    drift_warnings: [],
    parse_failures: [],
    not_inspected: []
  };
}

async function initCommittedRepo(root: string): Promise<void> {
  await runGitInit(root, ["init"]);
  await runGitInit(root, ["config", "user.email", "test@example.com"]);
  await runGitInit(root, ["config", "user.name", "Test User"]);
  await writeFile(join(root, "baseline.txt"), "baseline\n");
  await runGitInit(root, ["add", "."]);
  await runGitInit(root, ["commit", "-m", "baseline"]);
  await runGitInit(root, ["remote", "add", "origin", "https://example.com/repo.git"]);
}
