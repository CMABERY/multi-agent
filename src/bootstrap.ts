import { spawn } from "node:child_process";
import { access, readFile, mkdir } from "node:fs/promises";
import { join, normalize, resolve } from "node:path";
import { z } from "zod";
import { nextId } from "./ids.js";
import {
  AgentRegistrySchema,
  ArtifactIndexSchema,
  BootstrapIndexSchema,
  BootstrapPacketSchema,
  DeploymentPlanStoreSchema,
  IntentQueueSchema,
  ModelConfigSchema,
  TaskBoardSchema,
  type BootstrapClaim,
  type BootstrapContinuity,
  type BootstrapCounterContext,
  type BootstrapIndex,
  type BootstrapIndexEntry,
  type BootstrapPacket,
  type BootstrapPosture,
  type BootstrapWorkType
} from "./schemas.js";
import { nowIso, saveJson, saveText } from "./storage.js";

const GIT_OUTPUT_BYTE_CAP = 16 * 1024;
const WIDE_UNTRACKED_THRESHOLD = 12; // top-level untracked entries from ls-files --others --directory
const RECENT_ARTIFACT_LIMIT = 10;
const FORBIDDEN_GIT_ARGS = "git args not on allowlist";

const ALLOWED_GIT_ARGS: ReadonlyArray<readonly string[]> = [
  ["rev-parse", "--is-inside-work-tree"],
  ["rev-parse", "--git-dir"],
  ["rev-list", "--count", "HEAD"],
  ["remote"],
  ["status", "--porcelain", "-unormal"],
  ["ls-files", "--others", "--exclude-standard", "--directory"],
  ["rev-parse", "--abbrev-ref", "HEAD"]
];

const CORE_STATE_FILES: ReadonlyArray<{ path: string; schema: z.ZodTypeAny }> = [
  { path: "state/intent_queue.json", schema: IntentQueueSchema },
  { path: "state/task_board.json", schema: TaskBoardSchema },
  { path: "state/deployment_plan.json", schema: DeploymentPlanStoreSchema },
  { path: "state/agent_registry.json", schema: AgentRegistrySchema },
  { path: "state/model_config.json", schema: ModelConfigSchema },
  { path: "artifacts/artifact_index.json", schema: ArtifactIndexSchema }
];

const KNOWN_DEFAULT_PERSONAS = ["skeptical", "completeness", "rigor"];

export interface BootstrapResult {
  packet: BootstrapPacket;
  markdown: string;
}

export async function runBootstrap(
  root: string,
  options: { workType?: BootstrapWorkType; persist?: boolean } = {}
): Promise<BootstrapResult> {
  const workType = options.workType ?? "ordinary";
  const continuityResult = await collectContinuityFrame(root);
  const counterContext = await collectCounterContext(root, continuityResult.parseFailures);
  const posture = evaluatePosture({
    continuity: continuityResult.continuity,
    counterContext,
    workType
  });

  const indexBefore = await loadBootstrapIndex(root);
  const bootstrapId = nextId(
    "BS",
    indexBefore.bootstraps.map((entry) => entry.bootstrap_id)
  );
  const createdAt = nowIso();
  const claims = buildClaims({ continuity: continuityResult.continuity, counterContext });
  const packet: BootstrapPacket = BootstrapPacketSchema.parse({
    bootstrap_id: bootstrapId,
    created_at: createdAt,
    work_type: workType,
    posture: posture.posture,
    posture_reasons: posture.reasons,
    required_extra_review: posture.requiredExtraReview,
    continuity: continuityResult.continuity,
    counter_context: counterContext,
    claims
  });
  const markdown = renderMarkdown(packet);

  if (options.persist) {
    await persistPacket(root, packet, markdown, indexBefore);
  }

  return { packet, markdown };
}

export function postureExitCode(posture: BootstrapPosture): number {
  if (posture === "ask_human") return 2;
  if (posture === "governed") return 1;
  return 0;
}

interface ContinuityResult {
  continuity: BootstrapContinuity;
  parseFailures: Array<{ path: string; error: string }>;
}

async function collectContinuityFrame(root: string): Promise<ContinuityResult> {
  const parseFailures: Array<{ path: string; error: string }> = [];
  const project = await readProjectIdentity(root);
  const stack = await readStackSummary(root);

  const planStoreRaw = await safeLoadRaw(root, "state/deployment_plan.json", parseFailures);
  const boardRaw = await safeLoadRaw(root, "state/task_board.json", parseFailures);
  const artifactIndexRaw = await safeLoadRaw(root, "artifacts/artifact_index.json", parseFailures);

  const planParsed = DeploymentPlanStoreSchema.safeParse(planStoreRaw);
  if (!planParsed.success && planStoreRaw !== undefined) {
    parseFailures.push({ path: "state/deployment_plan.json", error: planParsed.error.message });
  }
  const planStore = planParsed.success ? planParsed.data : { deployment_plans: [] };

  const boardParsed = TaskBoardSchema.safeParse(boardRaw);
  if (!boardParsed.success && boardRaw !== undefined) {
    parseFailures.push({ path: "state/task_board.json", error: boardParsed.error.message });
  }
  const board = boardParsed.success ? boardParsed.data : { tasks: [] };

  const artifactParsed = ArtifactIndexSchema.safeParse(artifactIndexRaw);
  if (!artifactParsed.success && artifactIndexRaw !== undefined) {
    parseFailures.push({ path: "artifacts/artifact_index.json", error: artifactParsed.error.message });
  }
  const artifactIndex = artifactParsed.success ? artifactParsed.data : { artifacts: [] };

  const activeDeployments: BootstrapContinuity["active_deployments"] = planStore.deployment_plans
    .filter(
      (plan) =>
        plan.status === "running" ||
        plan.status === "approved" ||
        plan.status === "proposed" ||
        plan.status === "blocked"
    )
    .map((plan) => ({
      deployment_id: plan.deployment_id,
      status: plan.status,
      intent_id: plan.intent_id
    }));

  const activeTasks: BootstrapContinuity["active_tasks"] = board.tasks
    .filter(
      (task) =>
        task.status === "running" ||
        task.status === "blocked" ||
        task.status === "failed" ||
        task.status === "claimed"
    )
    .map((task) => ({
      task_id: task.task_id,
      status: task.status ?? "queued",
      title: task.title,
      blocker: task.blocker
    }));

  const recentArtifacts: BootstrapContinuity["recent_artifacts"] = [...artifactIndex.artifacts]
    .sort((left, right) => right.created_at.localeCompare(left.created_at))
    .slice(0, RECENT_ARTIFACT_LIMIT)
    .map((artifact) => ({
      artifact_id: artifact.artifact_id,
      task_id: artifact.task_id,
      type: artifact.type,
      path: artifact.path
    }));

  const conventions = {
    has_protocols_dir: await dirExists(root, "protocols"),
    has_instructions_dir: await dirExists(root, "instructions"),
    has_model_config: await fileExists(root, "state/model_config.json")
  };

  return {
    continuity: {
      project,
      stack,
      active_deployments: activeDeployments,
      active_tasks: activeTasks,
      recent_artifacts: recentArtifacts,
      conventions
    },
    parseFailures
  };
}

async function readProjectIdentity(
  root: string
): Promise<BootstrapContinuity["project"]> {
  try {
    const raw = await readFile(join(root, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { name?: unknown; description?: unknown; version?: unknown };
    return {
      name: typeof parsed.name === "string" ? parsed.name : "unknown",
      description: typeof parsed.description === "string" ? parsed.description : "",
      version: typeof parsed.version === "string" ? parsed.version : "0.0.0"
    };
  } catch {
    return { name: "unknown", description: "", version: "0.0.0" };
  }
}

async function readStackSummary(root: string): Promise<BootstrapContinuity["stack"]> {
  let runtime = "node";
  let language = "typescript";
  let keyDeps: string[] = [];
  try {
    const raw = await readFile(join(root, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      engines?: { node?: unknown };
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    if (parsed.engines && typeof parsed.engines.node === "string") {
      runtime = "node " + (parsed.engines.node);
    }
    const deps = { ...(parsed.dependencies ?? {}), ...(parsed.devDependencies ?? {}) };
    keyDeps = Object.keys(deps).sort();
  } catch {
    // tolerate missing/invalid package.json — captured already in project identity
  }
  if (await fileExists(root, "tsconfig.json")) language = "typescript";
  return { runtime, language, key_deps: keyDeps };
}

async function safeLoadRaw(
  root: string,
  relativePath: string,
  parseFailures: Array<{ path: string; error: string }>
): Promise<unknown> {
  try {
    const raw = await readFile(join(root, relativePath), "utf8");
    return JSON.parse(raw) as unknown;
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    parseFailures.push({
      path: relativePath,
      error: error instanceof Error ? error.message : String(error)
    });
    return undefined;
  }
}

async function collectCounterContext(
  root: string,
  parseFailuresFromContinuity: Array<{ path: string; error: string }>
): Promise<BootstrapCounterContext> {
  const git = await probeGit(root);
  const hygiene = await probeRepoHygiene(root);
  const additionalFailures = await probeRemainingStateParseability(root, parseFailuresFromContinuity);
  const parseFailures = mergeParseFailures(parseFailuresFromContinuity, additionalFailures);
  const runtimeWarnings = await probeRuntimeState(root);
  const driftWarnings = await probeDocStateDrift(root);
  return {
    git,
    hygiene,
    runtime_warnings: runtimeWarnings,
    drift_warnings: driftWarnings,
    parse_failures: parseFailures,
    not_inspected: [
      "node_modules contents",
      "dist/ build output",
      "external network or model providers",
      "deep tests/ coverage details"
    ]
  };
}

function mergeParseFailures(
  left: Array<{ path: string; error: string }>,
  right: Array<{ path: string; error: string }>
): Array<{ path: string; error: string }> {
  const seen = new Set(left.map((entry) => "" + (entry.path) + ":" + (entry.error)));
  const merged = [...left];
  for (const entry of right) {
    const key = "" + (entry.path) + ":" + (entry.error);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  return merged;
}

async function probeRemainingStateParseability(
  root: string,
  alreadyChecked: Array<{ path: string; error: string }>
): Promise<Array<{ path: string; error: string }>> {
  const failures: Array<{ path: string; error: string }> = [];
  const alreadyCheckedPaths = new Set(alreadyChecked.map((entry) => entry.path));
  for (const { path, schema } of CORE_STATE_FILES) {
    if (alreadyCheckedPaths.has(path)) continue;
    try {
      await access(join(root, path));
    } catch {
      continue;
    }
    try {
      const raw = await readFile(join(root, path), "utf8");
      const json = JSON.parse(raw) as unknown;
      const parsed = schema.safeParse(json);
      if (!parsed.success) {
        failures.push({ path, error: parsed.error.message });
      }
    } catch (error) {
      failures.push({
        path,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return failures;
}

async function probeGit(root: string): Promise<BootstrapCounterContext["git"]> {
  const result: BootstrapCounterContext["git"] = {
    present: false,
    has_commits: false,
    has_remote: false,
    dirty: false,
    status_capped: false,
    untracked_count: 0,
    untracked_capped: false
  };

  try {
    await access(join(root, ".git"));
    result.present = true;
  } catch {
    return result;
  }

  const insideWorkTree = await runGit(root, ["rev-parse", "--is-inside-work-tree"]);
  if (insideWorkTree.exitCode !== 0) {
    result.probe_error = insideWorkTree.stderr.trim() || "rev-parse failed";
    return result;
  }

  const branch = await runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch.exitCode === 0) {
    const trimmed = branch.stdout.trim();
    if (trimmed.length > 0) result.branch = trimmed;
  }

  const commitCount = await runGit(root, ["rev-list", "--count", "HEAD"]);
  if (commitCount.exitCode === 0) {
    const value = Number.parseInt(commitCount.stdout.trim(), 10);
    result.has_commits = Number.isFinite(value) && value > 0;
  } else {
    result.has_commits = false;
  }

  const remote = await runGit(root, ["remote"]);
  if (remote.exitCode === 0) {
    result.has_remote = remote.stdout.trim().length > 0;
  }

  const status = await runGit(root, ["status", "--porcelain", "-unormal"]);
  if (status.exitCode === 0) {
    result.status_capped = status.capped;
    const lines = status.stdout.split("\n").filter((line) => line.length > 0);
    result.dirty = lines.length > 0 || status.capped;
  } else if (!result.probe_error) {
    result.probe_error = status.stderr.trim() || "status failed";
  }

  const untrackedProbe = await runGit(root, ["ls-files", "--others", "--exclude-standard", "--directory"]);
  if (untrackedProbe.exitCode === 0) {
    result.untracked_capped = untrackedProbe.capped;
    result.untracked_count = untrackedProbe.stdout.split("\n").filter((line) => line.length > 0).length;
  } else if (!result.probe_error) {
    result.probe_error = untrackedProbe.stderr.trim() || "untracked probe failed";
  }

  return result;
}

async function probeRepoHygiene(root: string): Promise<BootstrapCounterContext["hygiene"]> {
  return {
    has_gitignore: await fileExists(root, ".gitignore"),
    dist_present: await dirExists(root, "dist"),
    node_modules_present: await dirExists(root, "node_modules")
  };
}

async function probeRuntimeState(root: string): Promise<string[]> {
  const warnings: string[] = [];
  const swallow: Array<{ path: string; error: string }> = [];
  const planRaw = await safeLoadRaw(root, "state/deployment_plan.json", swallow);
  const planParsed = DeploymentPlanStoreSchema.safeParse(planRaw);
  if (planParsed.success) {
    for (const plan of planParsed.data.deployment_plans) {
      if (plan.status === "running") {
        warnings.push("Deployment " + (plan.deployment_id) + " is currently running.");
      }
    }
  }

  const boardRaw = await safeLoadRaw(root, "state/task_board.json", swallow);
  const boardParsed = TaskBoardSchema.safeParse(boardRaw);
  if (boardParsed.success) {
    const running = boardParsed.data.tasks.filter((task) => task.status === "running");
    if (running.length > 0) {
      warnings.push("" + (running.length) + " task(s) in running state: " + (running.map((task) => task.task_id).join(", ")) + ".");
    }
    const blocked = boardParsed.data.tasks.filter((task) => task.status === "blocked");
    if (blocked.length > 0) {
      warnings.push("" + (blocked.length) + " task(s) blocked.");
    }
    const failed = boardParsed.data.tasks.filter((task) => task.status === "failed");
    if (failed.length > 0) {
      warnings.push("" + (failed.length) + " task(s) failed.");
    }
  }

  return warnings;
}

async function probeDocStateDrift(root: string): Promise<string[]> {
  const warnings: string[] = [];
  const swallow: Array<{ path: string; error: string }> = [];
  const registryRaw = await safeLoadRaw(root, "state/agent_registry.json", swallow);
  const registryParsed = AgentRegistrySchema.safeParse(registryRaw);
  if (!registryParsed.success) return warnings;
  const reviewerPersonas = new Set<string>();
  for (const agent of registryParsed.data.agents) {
    if (agent.role.includes("Reviewer") && agent.reviewer_persona) {
      reviewerPersonas.add(agent.reviewer_persona);
    }
  }
  for (const expected of KNOWN_DEFAULT_PERSONAS) {
    if (!reviewerPersonas.has(expected)) {
      warnings.push(
        "Default reviewer persona \"" + (expected) + "\" is missing from agent_registry; docs (workspace.ts seed) reference it."
      );
    }
  }
  return warnings;
}

interface PostureInput {
  continuity: BootstrapContinuity;
  counterContext: BootstrapCounterContext;
  workType: BootstrapWorkType;
}

interface PostureResult {
  posture: BootstrapPosture;
  reasons: string[];
  requiredExtraReview: string[];
}

export function evaluatePosture(input: PostureInput): PostureResult {
  const escalations: Array<{ to: BootstrapPosture; reason: string }> = [];

  for (const failure of input.counterContext.parse_failures) {
    escalations.push({ to: "ask_human", reason: "core state unparseable: " + (failure.path) });
  }

  const runningDeployments = input.continuity.active_deployments.filter(
    (deployment) => deployment.status === "running"
  );
  const stateRiskWorkTypes: BootstrapWorkType[] = ["stateful", "risky", "architecture"];
  if (runningDeployments.length > 0 && stateRiskWorkTypes.includes(input.workType)) {
    escalations.push({
      to: "ask_human",
      reason: "active running deployment(s) overlap with --work-type " + (input.workType) + ": " + (runningDeployments
        .map((deployment) => deployment.deployment_id)
        .join(", ")) + "."
    });
  }

  const noSourceTruth = !input.counterContext.git.present || !input.counterContext.git.has_commits;
  const wideUntracked =
    input.counterContext.git.untracked_count > WIDE_UNTRACKED_THRESHOLD || input.counterContext.git.untracked_capped;
  if (input.workType === "risky" && (noSourceTruth || wideUntracked)) {
    escalations.push({
      to: "ask_human",
      reason: "risky work without reliable source-of-truth (no commits or large untracked surface)."
    });
  }

  if (wideUntracked) {
    escalations.push({
      to: "wide_scan",
      reason: "large untracked surface: untracked_count=" + (input.counterContext.git.untracked_count) + ", untracked_capped=" + (input.counterContext.git.untracked_capped) + " - perception narrowed; widen scope before acting."
    });
  }

  if (input.counterContext.git.status_capped) {
    escalations.push({
      to: "wide_scan",
      reason: "git status output capped: tracked/untracked dirty details may be incomplete; inspect full status before acting."
    });
  }

  if (!input.counterContext.git.present) {
    escalations.push({ to: "wide_scan", reason: "git repository not present in workspace root." });
  } else {
    if (!input.counterContext.git.has_commits) {
      escalations.push({ to: "wide_scan", reason: "git repository has no commits yet." });
    }
    if (!input.counterContext.git.has_remote) {
      escalations.push({ to: "wide_scan", reason: "git repository has no remote configured." });
    }
  }

  if (
    !input.counterContext.hygiene.has_gitignore &&
    (input.counterContext.hygiene.dist_present || input.counterContext.hygiene.node_modules_present)
  ) {
    escalations.push({
      to: "wide_scan",
      reason: "build/install output present without .gitignore (dist/ or node_modules/ untracked)."
    });
  }

  if (input.continuity.active_deployments.some((deployment) => deployment.status === "running")) {
    escalations.push({ to: "wide_scan", reason: "at least one deployment is in running state." });
  }
  if (input.continuity.active_tasks.some((task) => task.status === "running")) {
    escalations.push({ to: "wide_scan", reason: "at least one task is in running state." });
  }

  for (const warning of input.counterContext.drift_warnings) {
    escalations.push({ to: "wide_scan", reason: "doc/code drift: " + (warning) });
  }

  const reasons = escalations.map((entry) => entry.reason);
  let posture: BootstrapPosture = "normal";
  for (const entry of escalations) {
    if (postureRank(entry.to) > postureRank(posture)) posture = entry.to;
  }

  const requiredExtraReview: string[] = [];
  const escalationToGovernedAllowed: BootstrapWorkType[] = ["risky", "architecture"];
  if (posture === "wide_scan" && escalationToGovernedAllowed.includes(input.workType)) {
    posture = "governed";
    if (input.continuity.active_deployments.some((deployment) => deployment.status === "running")) {
      requiredExtraReview.push("Pause or complete the running deployment before mutating shared state.");
    }
    if (!input.counterContext.git.present || !input.counterContext.git.has_commits) {
      requiredExtraReview.push("Initialize git and commit a baseline before making architecture-level changes.");
    }
    if (!input.counterContext.hygiene.has_gitignore) {
      requiredExtraReview.push("Add a .gitignore covering dist/ and node_modules/ before staging changes.");
    }
    if (input.counterContext.drift_warnings.length > 0) {
      requiredExtraReview.push("Reconcile agent_registry vs workspace.ts default seed drift before changes.");
    }
    requiredExtraReview.push("Run maw plan-check against any new deployment before approval.");
  }

  return { posture, reasons, requiredExtraReview };
}

function postureRank(posture: BootstrapPosture): number {
  if (posture === "ask_human") return 3;
  if (posture === "governed") return 2;
  if (posture === "wide_scan") return 1;
  return 0;
}

function buildClaims(input: {
  continuity: BootstrapContinuity;
  counterContext: BootstrapCounterContext;
}): BootstrapClaim[] {
  const claims: BootstrapClaim[] = [
    {
      claim: "Project identity: " + (input.continuity.project.name) + "@" + (input.continuity.project.version) + ".",
      source_paths: ["package.json"],
      confidence: "documented",
      staleness_risk: "low"
    },
    {
      claim: "Runtime: " + (input.continuity.stack.runtime) + "; language: " + (input.continuity.stack.language) + ".",
      source_paths: ["package.json", "tsconfig.json"],
      confidence: "documented",
      staleness_risk: "low"
    },
    {
      claim: "Active deployments observed: " + (input.continuity.active_deployments.length) + ".",
      source_paths: ["state/deployment_plan.json"],
      confidence: "state_observed",
      staleness_risk: "high"
    },
    {
      claim: "Active task surface: " + (input.continuity.active_tasks.length) + " task(s) running/blocked/failed.",
      source_paths: ["state/task_board.json"],
      confidence: "state_observed",
      staleness_risk: "high"
    },
    {
      claim: input.counterContext.git.present
        ? "Git repository present (commits=" + (input.counterContext.git.has_commits) + ", remote=" + (input.counterContext.git.has_remote) + ", status_capped=" + (input.counterContext.git.status_capped) + ", top-level untracked entries=" + (input.counterContext.git.untracked_count) + (input.counterContext.git.untracked_capped ? ", capped" : "") + ")."
        : "No git repository at workspace root.",
      source_paths: [".git"],
      command: "git rev-parse --is-inside-work-tree",
      confidence: "code_inferred",
      staleness_risk: "medium"
    }
  ];

  if (input.counterContext.parse_failures.length > 0) {
    claims.push({
      claim: "Core state parse failures: " + (input.counterContext.parse_failures.length) + ".",
      source_paths: input.counterContext.parse_failures.map((failure) => failure.path),
      confidence: "state_observed",
      staleness_risk: "high"
    });
  }
  if (input.counterContext.drift_warnings.length > 0) {
    claims.push({
      claim: "Doc/code drift signals detected: " + (input.counterContext.drift_warnings.length) + ".",
      source_paths: ["state/agent_registry.json", "src/workspace.ts"],
      confidence: "code_inferred",
      staleness_risk: "medium"
    });
  }

  return claims;
}

function renderMarkdown(packet: BootstrapPacket): string {
  const elevatedPostures: BootstrapPosture[] = ["wide_scan", "ask_human", "governed"];
  const counterFirst = elevatedPostures.includes(packet.posture);
  const sections = [
    "# Bootstrap " + (packet.bootstrap_id),
    "",
    "Created: " + (packet.created_at),
    "Work Type: " + (packet.work_type),
    "Posture: " + (packet.posture),
    "",
    "Bootstrap is readiness support, not proof of complete understanding.",
    "",
    "## Posture",
    ...(packet.posture_reasons.length === 0
      ? ["- No escalations; posture is normal."]
      : packet.posture_reasons.map((reason) => "- " + (reason))),
    ...(packet.required_extra_review.length > 0
      ? ["", "### Required Extra Review", ...packet.required_extra_review.map((entry) => "- " + (entry))]
      : []),
    ""
  ];

  const continuityBlock = renderContinuityBlock(packet.continuity);
  const counterBlock = renderCounterContextBlock(packet.counter_context);

  if (counterFirst) {
    sections.push(...counterBlock, "", ...continuityBlock);
  } else {
    sections.push(...continuityBlock, "", ...counterBlock);
  }

  sections.push("", "## Claims");
  if (packet.claims.length === 0) {
    sections.push("- None");
  } else {
    for (const claim of packet.claims) {
      const sources = claim.source_paths.length > 0 ? " sources=" + (claim.source_paths.join(",")) : "";
      const command = claim.command ? " command=" + (claim.command) : "";
      sections.push(
        "- [" + (claim.confidence) + "/" + (claim.staleness_risk) + "] " + (claim.claim) + (sources) + (command)
      );
    }
  }
  sections.push("");
  return sections.join("\n");
}

function renderContinuityBlock(continuity: BootstrapContinuity): string[] {
  const lines: string[] = [
    "## Continuity Frame",
    "- Project: " + (continuity.project.name) + "@" + (continuity.project.version) + " — " + (continuity.project.description || "no description"),
    "- Stack: " + (continuity.stack.runtime) + ", " + (continuity.stack.language),
    "- Key deps: " + (continuity.stack.key_deps.length === 0 ? "none" : continuity.stack.key_deps.join(", ")),
    "- Conventions: protocols=" + (continuity.conventions.has_protocols_dir) + " instructions=" + (continuity.conventions.has_instructions_dir) + " model_config=" + (continuity.conventions.has_model_config),
    "",
    "### Active Deployments",
    ...(continuity.active_deployments.length === 0
      ? ["- None"]
      : continuity.active_deployments.map(
          (deployment) =>
            "- " + (deployment.deployment_id) + " [" + (deployment.status) + "] intent=" + (deployment.intent_id)
        )),
    "",
    "### Active Tasks",
    ...(continuity.active_tasks.length === 0
      ? ["- None"]
      : continuity.active_tasks.map(
          (task) => "- " + (task.task_id) + " [" + (task.status) + "] " + (task.title) + (task.blocker ? " (blocker: " + (task.blocker) + ")" : "")
        )),
    "",
    "### Recent Artifacts",
    ...(continuity.recent_artifacts.length === 0
      ? ["- None"]
      : continuity.recent_artifacts.map(
          (artifact) => "- " + (artifact.artifact_id) + " [" + (artifact.type) + "] task=" + (artifact.task_id) + " path=" + (artifact.path)
        ))
  ];
  return lines;
}

function renderCounterContextBlock(counter: BootstrapCounterContext): string[] {
  const lines: string[] = [
    "## Counter-Context Frame",
    "- Git: present=" + (counter.git.present) + " commits=" + (counter.git.has_commits) + " remote=" + (counter.git.has_remote) + " dirty=" + (counter.git.dirty) + (counter.git.status_capped ? " status_capped=true" : "") + " top-level untracked entries=" + (counter.git.untracked_count) + (counter.git.untracked_capped ? " (capped)" : "") + (counter.git.branch ? " branch=" + (counter.git.branch) : "") + (counter.git.probe_error ? " probe_error=" + (counter.git.probe_error) : ""),
    "- Hygiene: gitignore=" + (counter.hygiene.has_gitignore) + " dist=" + (counter.hygiene.dist_present) + " node_modules=" + (counter.hygiene.node_modules_present),
    "",
    "### Runtime Warnings",
    ...(counter.runtime_warnings.length === 0
      ? ["- None"]
      : counter.runtime_warnings.map((warning) => "- " + (warning))),
    "",
    "### Drift Warnings",
    ...(counter.drift_warnings.length === 0
      ? ["- None"]
      : counter.drift_warnings.map((warning) => "- " + (warning))),
    "",
    "### Parse Failures",
    ...(counter.parse_failures.length === 0
      ? ["- None"]
      : counter.parse_failures.map((failure) => "- " + (failure.path) + ": " + (failure.error))),
    "",
    "### Not Inspected",
    ...counter.not_inspected.map((entry) => "- " + (entry))
  ];
  return lines;
}

async function persistPacket(
  root: string,
  packet: BootstrapPacket,
  markdown: string,
  indexBefore: BootstrapIndex
): Promise<void> {
  const dir = "state/bootstrap";
  await mkdir(join(root, dir), { recursive: true });
  const mdPath = "" + (dir) + "/" + (packet.bootstrap_id) + ".md";
  const jsonPath = "" + (dir) + "/" + (packet.bootstrap_id) + ".json";
  await saveText(root, mdPath, markdown);
  await saveJson(root, jsonPath, packet);
  const newEntry: BootstrapIndexEntry = {
    bootstrap_id: packet.bootstrap_id,
    created_at: packet.created_at,
    posture: packet.posture,
    md_path: mdPath,
    json_path: jsonPath
  };
  const nextIndex: BootstrapIndex = BootstrapIndexSchema.parse({
    bootstraps: [...indexBefore.bootstraps, newEntry]
  });
  await saveJson(root, "" + (dir) + "/index.json", nextIndex);
}

async function loadBootstrapIndex(root: string): Promise<BootstrapIndex> {
  const swallow: Array<{ path: string; error: string }> = [];
  const raw = await safeLoadRaw(root, "state/bootstrap/index.json", swallow);
  const parsed = BootstrapIndexSchema.safeParse(raw);
  return parsed.success ? parsed.data : { bootstraps: [] };
}

async function fileExists(root: string, relativePath: string): Promise<boolean> {
  if (pathEscapesWorkspace(root, relativePath)) return false;
  try {
    await access(join(root, relativePath));
    return true;
  } catch {
    return false;
  }
}

async function dirExists(root: string, relativePath: string): Promise<boolean> {
  return fileExists(root, relativePath);
}

function pathEscapesWorkspace(root: string, relativePath: string): boolean {
  const absolute = resolve(root, normalize(relativePath));
  const workspace = resolve(root);
  return !absolute.startsWith(workspace);
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT"
  );
}

interface GitInvocation {
  exitCode: number;
  stdout: string;
  stderr: string;
  byteLength: number;
  capped: boolean;
}

async function runGit(root: string, args: ReadonlyArray<string>): Promise<GitInvocation> {
  if (!isAllowedGitArgs(args)) {
    return { exitCode: 1, stdout: "", stderr: FORBIDDEN_GIT_ARGS, byteLength: 0, capped: false };
  }
  return await new Promise<GitInvocation>((resolvePromise) => {
    const child = spawn("git", [...args], { cwd: root, shell: false, windowsHide: true });
    const stdoutChunks: Buffer[] = [];
    let stderr = "";
    let bytes = 0;
    let capturedBytes = 0;
    let truncated = false;
    const capturedStdout = () => Buffer.concat(stdoutChunks).toString("utf8");
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (truncated) return;
      const remaining = GIT_OUTPUT_BYTE_CAP - capturedBytes;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      if (chunk.length <= remaining) {
        stdoutChunks.push(chunk);
        capturedBytes += chunk.length;
      } else {
        stdoutChunks.push(chunk.subarray(0, remaining));
        capturedBytes += remaining;
        truncated = true;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", () => {
      resolvePromise({
        exitCode: 1,
        stdout: capturedStdout(),
        stderr: stderr || "git not available",
        byteLength: bytes,
        capped: truncated
      });
    });
    child.on("close", (exitCode) => {
      resolvePromise({ exitCode: exitCode ?? 1, stdout: capturedStdout(), stderr, byteLength: bytes, capped: truncated });
    });
  });
}

function isAllowedGitArgs(args: ReadonlyArray<string>): boolean {
  return ALLOWED_GIT_ARGS.some(
    (allowed) => allowed.length === args.length && allowed.every((value, index) => value === args[index])
  );
}
