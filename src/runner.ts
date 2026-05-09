import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { normalize, relative, resolve } from "node:path";
import { z } from "zod";
import { addArtifact, ensureRunDir } from "./artifacts.js";
import { hasApprovedDeployment } from "./approvals.js";
import { computeConsensus } from "./consensus.js";
import { runContextCheck } from "./contextCheck.js";
import { nextId } from "./ids.js";
import { isDeliverableTask, isReviewOrSynthesisTask } from "./intelligenceCommon.js";
import { incrementMetric } from "./metrics.js";
import {
  createDefaultModelClient,
  estimateModelCostUsd,
  loadModelConfig,
  type ModelClient,
  type ModelTool,
  selectModel
} from "./openai.js";
import {
  classifyCommandAuthorization,
  classifyToolAuthorization,
  evaluateAuthorization,
  recordPermissionAudit,
  type PolicyDecision
} from "./permissionPolicy.js";
import { beginTransaction, markTransaction } from "./transactions.js";
import { buildReviewerInstructions } from "./reviewerPrompts.js";
import { recordReview } from "./reviews.js";
import {
  AgentRegistrySchema,
  ArtifactIndexSchema,
  ChatStoreSchema,
  PerCriterionVerdictSchema,
  ReviewIssueSchema,
  DeploymentPlanStoreSchema,
  TaskBoardSchema,
  type Agent,
  type Artifact,
  type DeploymentAssignment,
  type ReviewerPersona,
  type Task
} from "./schemas.js";
import { requireCurrentPassingPlanCheck } from "./planCheck.js";
import { loadJson, nowIso, saveJson, saveText } from "./storage.js";

class HaltError extends Error {
  constructor(public readonly reason: string) {
    super("Model halted task with reason: " + reason);
    this.name = "HaltError";
  }
}

function detectHaltSignal(text: string): { reason: string } | null {
  const stripped = text.replace(/^[\s\n]+/, "");
  if (!stripped.startsWith("HALT:")) return null;
  const newlineIndex = stripped.indexOf("\n");
  const firstLine = newlineIndex === -1 ? stripped : stripped.slice(0, newlineIndex);
  const match = /^HALT:\s+(.+)$/.exec(firstLine);
  const captured = match?.[1];
  if (!captured) return null;
  const reason = captured.trim();
  if (!reason) return null;
  return { reason };
}

const ReviewerOutputSchema = z.object({
  reviewer_persona: z.enum(["default", "skeptical", "completeness", "rigor", "adversarial"]).optional(),
  status: z.enum(["pass", "fail", "abstain"]).optional(),
  per_criterion: z.array(PerCriterionVerdictSchema).min(1),
  identified_issues: z.array(ReviewIssueSchema).default([]),
  free_form_assessment: z.string().default("")
});

const outputArtifactTypes = new Set(["model_output", "command_output"]);
const WEB_SEARCH_SOURCES_INCLUDE = "web_search_call.action.sources";

async function authorizeModelTools(
  root: string,
  agent: Agent,
  task: Task,
  deploymentId: string | undefined
): Promise<{
  tools?: ModelTool[];
  toolChoice?: "auto";
  include?: string[];
  decisions: Array<{ tool: string; decision: PolicyDecision }>;
}> {
  const decisions: Array<{ tool: string; decision: PolicyDecision }> = [];
  if (!agent.allowed_tools.includes("web_search")) return { decisions };

  const dependencyArtifacts = await collectDependencyArtifacts(root, task);
  const signals = {
    dependencyArtifactCount: dependencyArtifacts.length,
    workspaceContextPathCount: task.input_context.length
  };
  const request = classifyToolAuthorization({
    toolType: "web_search",
    agent,
    task,
    signals
  });
  if (!request) return { decisions };
  const decision = evaluateAuthorization(request);
  await recordPermissionAudit(root, { deploymentId, request, decision });
  decisions.push({ tool: "web_search", decision });
  if (decision.decision === "deny") {
    await addChatDefect(
      root,
      task.task_id,
      "Hosted web_search denied for " +
        task.task_id +
        "/" +
        agent.agent_id +
        " — missing grants: " +
        decision.missing_grants.join(", ") +
        ". Tool was dropped from the model request; plan-check should have caught this earlier."
    );
    return { decisions };
  }
  return {
    tools: [{ type: "web_search" }],
    toolChoice: "auto",
    include: [WEB_SEARCH_SOURCES_INCLUDE],
    decisions
  };
}

function buildModelAgentInstructions(agent: Agent, tools: ModelTool[] | undefined): string {
  if (!tools || tools.length === 0) {
    return "You are " + (agent.role) + ". Complete the assigned task using only the scoped context packet.";
  }
  return (
    "You are " +
    (agent.role) +
    ". Complete the assigned task using the scoped context packet and the provided hosted tools. Use hosted tools only when needed, and cite sources returned by tool-backed research."
  );
}

export async function runDeployment(
  root: string,
  input: {
    deploymentId: string;
    execute?: boolean;
    rerun?: boolean;
    modelClient?: ModelClient;
  }
): Promise<{ completed: string[]; failed: string[] }> {
  const plans = DeploymentPlanStoreSchema.parse(await loadJson(root, "state/deployment_plan.json"));
  const plan = plans.deployment_plans.find((entry) => entry.deployment_id === input.deploymentId);
  if (!plan) throw new Error("Deployment not found: " + (input.deploymentId));

  if (plan.approval_required && !(await hasApprovedDeployment(root, plan))) {
    throw new Error("Deployment " + (plan.deployment_id) + " requires explicit approval before execution.");
  }
  if (plan.status !== "approved" && !input.rerun) {
    throw new Error("Deployment " + (plan.deployment_id) + " is not approved. Current status: " + (plan.status));
  }
  await requireCurrentPassingPlanCheck(root, plan, "execution");

  const board = TaskBoardSchema.parse(await loadJson(root, "state/task_board.json"));
  const registry = AgentRegistrySchema.parse(await loadJson(root, "state/agent_registry.json"));
  preflightDeployment(board, registry, plan.assignments, Boolean(input.execute));
  const completed: string[] = [];
  const failed: string[] = [];
  if (input.rerun && plan.status === "running") {
    throw new Error("Deployment " + (plan.deployment_id) + " is already running.");
  }
  plan.status = "running";
  plan.updated_at = nowIso();
  await saveJson(root, "state/deployment_plan.json", plans);

  for (const assignment of plan.assignments) {
    const task = board.tasks.find((entry) => entry.task_id === assignment.task_id);
    if (!task) throw new Error("Task not found: " + (assignment.task_id));
    const agent = registry.agents.find((entry) => entry.agent_id === assignment.agent_id);
    if (!agent) throw new Error("Agent not found: " + (assignment.agent_id));
    const unmetDependency = findUnmetDependency(board, task);
    if (unmetDependency) {
      await markTask(board, root, task, "blocked", unmetDependency.reason);
      failed.push(task.task_id);
      continue;
    }

    try {
      const contextCheck = await runContextCheck(root, { taskId: task.task_id });
      if (contextCheck.status === "fail") {
        const issueCodes = contextCheck.issues.map((issue) => issue.code).join(", ");
        const message = "Context check failed for " + (task.task_id) + ": " + (issueCodes || "unknown issue");
        await markTask(board, root, task, "blocked", "Context check failed: " + (issueCodes || "unknown issue"));
        await addChatBlocker(root, task.task_id, message);
        failed.push(task.task_id);
        plan.status = "failed";
        plan.updated_at = nowIso();
        await saveJson(root, "state/deployment_plan.json", plans);
        continue;
      }
      await markTask(board, root, task, "running");
      const runDir = await ensureRunDir(root, task.task_id);
      const packet = await buildDelegationPacket(root, task, assignment, agent);
      await saveText(root, "" + (runDir) + "/delegation_packet.md", packet);

      if (assignment.executor === "dry_run") {
        await runDryRun(root, task, runDir);
      } else if (assignment.executor === "model_agent") {
        await runModelAgent(root, task, agent, runDir, plan.deployment_id, input.modelClient);
      } else {
        await runLocalCommand(root, task, agent, runDir, Boolean(input.execute), plan.deployment_id);
      }
      await markTask(board, root, task, "completed");
      if (task.review_required && isDeliverableTask(task)) {
        await spawnStructuredReviews(root, task, registry.agents, input.modelClient);
      }
      completed.push(task.task_id);
    } catch (error) {
      if (error instanceof HaltError) {
        await markTask(board, root, task, "blocked", "HALT: " + error.reason);
        await addChatHalt(root, task.task_id, error.reason);
        failed.push(task.task_id);
        plan.status = "failed";
        plan.updated_at = nowIso();
        await saveJson(root, "state/deployment_plan.json", plans);
        continue;
      }
      await markTask(board, root, task, "failed", error instanceof Error ? error.message : String(error));
      await addChatBlocker(root, task.task_id, error instanceof Error ? error.message : String(error));
      failed.push(task.task_id);
      plan.status = "failed";
      plan.updated_at = nowIso();
      await saveJson(root, "state/deployment_plan.json", plans);
    }
  }

  plan.status = failed.length > 0 ? "failed" : "completed";
  plan.updated_at = nowIso();
  await saveJson(root, "state/deployment_plan.json", plans);
  return { completed, failed };
}

function preflightDeployment(
  board: { tasks: Task[] },
  registry: { agents: Agent[] },
  assignments: DeploymentAssignment[],
  execute: boolean
): void {
  for (const assignment of assignments) {
    const task = board.tasks.find((entry) => entry.task_id === assignment.task_id);
    if (!task) throw new Error("Task not found: " + (assignment.task_id));
    const agent = registry.agents.find((entry) => entry.agent_id === assignment.agent_id);
    if (!agent) throw new Error("Agent not found: " + (assignment.agent_id));
    if (assignment.executor !== "local_command") continue;
    if (!execute) throw new Error("Local command task " + (task.task_id) + " requires --execute.");
    if (!task.command) throw new Error("Local command task " + (task.task_id) + " does not define a command.");
    if (!agent.command_allowlist.includes(task.command.command)) {
      throw new Error("Command is not allowlisted for " + (agent.agent_id) + ": " + (task.command.command));
    }
  }
}

function findUnmetDependency(
  board: { tasks: Task[] },
  task: Task
): { taskId: string; reason: string } | undefined {
  const visited = new Set<string>();

  function failedOrBlockedDependency(taskId: string): string | undefined {
    if (visited.has(taskId)) return undefined;
    visited.add(taskId);
    const dependencyTask = board.tasks.find((entry) => entry.task_id === taskId);
    if (!dependencyTask) return undefined;
    if (dependencyTask.status === "failed" || dependencyTask.status === "blocked") return taskId;
    for (const dependency of dependencyTask.dependencies) {
      const blocked = failedOrBlockedDependency(dependency);
      if (blocked) return blocked;
    }
    return undefined;
  }

  for (const dependency of task.dependencies) {
    const upstreamFailure = failedOrBlockedDependency(dependency);
    if (upstreamFailure) {
      return {
        taskId: upstreamFailure,
        reason: "Upstream task " + (upstreamFailure) + " failed"
      };
    }
    const dependencyTask = board.tasks.find((entry) => entry.task_id === dependency);
    if (dependencyTask?.status !== "completed" && dependencyTask?.status !== "approved") {
      return {
        taskId: dependency,
        reason: "Dependency not completed: " + (dependency)
      };
    }
  }
  return undefined;
}

async function runDryRun(root: string, task: Task, runDir: string): Promise<void> {
  await saveJson(root, "" + (runDir) + "/adapter_result.json", {
    executor: "dry_run",
    status: "delegation_packet_emitted"
  });
  await addArtifact(root, {
    taskId: task.task_id,
    path: "" + (runDir) + "/delegation_packet.md",
    type: "delegation_packet",
    description: "Delegation packet for " + (task.task_id)
  });
  await incrementMetric(root, "dry_runs");
}

async function runModelAgent(
  root: string,
  task: Task,
  agent: Agent,
  runDir: string,
  deploymentId: string | undefined,
  modelClient?: ModelClient
): Promise<void> {
  const config = await loadModelConfig(root);
  const client = modelClient ?? (await createDefaultModelClient(root));
  const contextPacket = await buildScopedContextPacket(root, task);
  const model = selectModel(config, agent.model_tier ?? task.model_tier, agent.model);
  const toolRequest = await authorizeModelTools(root, agent, task, deploymentId);
  await saveJson(root, "" + (runDir) + "/model_request_summary.json", {
    model,
    agent_id: agent.agent_id,
    task_id: task.task_id,
    allowed_tools: agent.allowed_tools,
    enabled_tools: toolRequest.tools?.map((tool) => tool.type) ?? [],
    policy_decisions: toolRequest.decisions.map((entry) => ({
      tool: entry.tool,
      decision: entry.decision.decision,
      required_grants: entry.decision.required_grants,
      missing_grants: entry.decision.missing_grants,
      reason: entry.decision.reason
    }))
  });
  const output = await client.createResponse({
    model,
    instructions: buildModelAgentInstructions(agent, toolRequest.tools),
    input: contextPacket,
    maxOutputTokens: config.max_output_tokens,
    tools: toolRequest.tools,
    toolChoice: toolRequest.toolChoice,
    include: toolRequest.include
  });
  const responseText = normalizeModelOutputForAcceptance(task, output.text);
  await saveText(root, "" + (runDir) + "/response_output.md", responseText);
  await incrementMetric(root, "model_calls", estimateModelCostUsd(config, model, output.usage));
  if (output.truncated) {
    await saveJson(root, "" + (runDir) + "/output_truncated.json", {
      reason: output.reason ?? output.status ?? "incomplete",
      max_output_tokens: config.max_output_tokens,
      response_chars: responseText.length
    });
    throw new Error("Model response truncated at max_output_tokens (" + (config.max_output_tokens) + ").");
  }
  const halt = detectHaltSignal(responseText);
  if (halt) {
    await addArtifact(root, {
      taskId: task.task_id,
      path: "" + (runDir) + "/response_output.md",
      type: "model_halt",
      description: "Model HALT for " + (task.task_id) + ": " + halt.reason
    });
    throw new HaltError(halt.reason);
  }
  await addArtifact(root, {
    taskId: task.task_id,
    path: "" + (runDir) + "/response_output.md",
    type: "model_output",
    description: "Model output for " + (task.task_id)
  });
}

async function runLocalCommand(
  root: string,
  task: Task,
  agent: Agent,
  runDir: string,
  execute: boolean,
  deploymentId: string | undefined
): Promise<void> {
  if (!execute) {
    throw new Error("Local command task " + (task.task_id) + " requires --execute.");
  }
  if (!task.command) {
    throw new Error("Local command task " + (task.task_id) + " does not define a command.");
  }
  if (!agent.command_allowlist.includes(task.command.command)) {
    throw new Error("Command is not allowlisted for " + (agent.agent_id) + ": " + (task.command.command));
  }
  const policyRequest = classifyCommandAuthorization({
    commandSpec: task.command,
    agent,
    task
  });
  const policyDecision = evaluateAuthorization(policyRequest);
  const auditEvent = await recordPermissionAudit(root, {
    deploymentId,
    request: policyRequest,
    decision: policyDecision
  });
  const transaction = await beginTransaction(root, {
    deploymentId,
    taskId: task.task_id,
    agentId: agent.agent_id,
    actionKind: policyRequest.kind,
    actionSignals: {
      command_name: task.command.command,
      arg_count: task.command.args.length
    },
    permissionAuditEventId: auditEvent.event_id
  });
  if (policyDecision.decision === "deny") {
    const denyReason =
      "Local command denied by permission policy for " +
      task.task_id +
      "/" +
      agent.agent_id +
      ". Missing grants: " +
      policyDecision.missing_grants.join(", ") +
      ". Plan-check should have caught this earlier.";
    await markTransaction(root, transaction.transaction_id, {
      status: "Aborted",
      failureReason: denyReason
    });
    throw new Error(denyReason);
  }
  let terminalRecorded = false;
  try {
    const result = await spawnCommand(task.command.command, task.command.args);
    await saveText(root, "" + (runDir) + "/command_output.txt", result.stdout);
    await saveText(root, "" + (runDir) + "/command_error.txt", result.stderr);
    await saveJson(root, "" + (runDir) + "/command_result.json", { exit_code: result.exitCode });
    if (result.exitCode !== 0) {
      const failureReason = "Command exited with code " + result.exitCode;
      await markTransaction(root, transaction.transaction_id, {
        status: "Failed",
        failureReason
      });
      terminalRecorded = true;
      throw new Error(failureReason);
    }
    await addArtifact(root, {
      taskId: task.task_id,
      path: "" + (runDir) + "/command_output.txt",
      type: "command_output",
      description: "Command stdout for " + (task.task_id)
    });
    await incrementMetric(root, "local_commands");
    await markTransaction(root, transaction.transaction_id, { status: "Committed" });
    terminalRecorded = true;
  } catch (error) {
    if (!terminalRecorded) {
      await markTransaction(root, transaction.transaction_id, {
        status: "Failed",
        failureReason: error instanceof Error ? error.message : String(error)
      });
    }
    throw error;
  }
}

async function spawnStructuredReviews(
  root: string,
  task: Task,
  agents: Agent[],
  modelClient?: ModelClient
): Promise<void> {
  const deliverable = await latestDeliverableArtifact(root, task.task_id);
  if (!deliverable) {
    await addChatDefect(
      root,
      task.task_id,
      "Task " + (task.task_id) + " requires review but has no model_output or command_output artifact."
    );
    return;
  }

  const reviewers = selectReviewers(agents, task);
  if (reviewers.length === 0) {
    await addChatDefect(root, task.task_id, "Task " + (task.task_id) + " requires review but no reviewer personas are registered.");
    return;
  }
  for (const reviewer of reviewers) {
    await runStructuredReviewer(root, task, reviewer, deliverable, modelClient);
  }
  await computeConsensus(root, { taskId: task.task_id });
}

async function latestDeliverableArtifact(root: string, taskId: string): Promise<Artifact | undefined> {
  const index = ArtifactIndexSchema.parse(await loadJson(root, "artifacts/artifact_index.json"));
  return index.artifacts
    .filter((artifact) => artifact.task_id === taskId && outputArtifactTypes.has(artifact.type))
    .at(-1);
}

function selectReviewers(agents: Agent[], task: Task): Agent[] {
  const required = task.risk_level === "high" ? 3 : task.risk_level === "medium" ? 2 : 1;
  const seenPersonas = new Set<ReviewerPersona>();
  const reviewers: Agent[] = [];
  for (const agent of agents) {
    if (!agent.role.includes("Reviewer") || !agent.reviewer_persona) continue;
    if (seenPersonas.has(agent.reviewer_persona)) continue;
    seenPersonas.add(agent.reviewer_persona);
    reviewers.push(agent);
    if (reviewers.length === required) break;
  }
  return reviewers;
}

async function runStructuredReviewer(
  root: string,
  task: Task,
  reviewer: Agent,
  deliverable: Artifact,
  modelClient?: ModelClient
): Promise<void> {
  const persona = reviewer.reviewer_persona ?? "default";
  const runDir = await ensureRunDir(root, task.task_id);
  const config = await loadModelConfig(root);
  const client = modelClient ?? (await createDefaultModelClient(root));
  const model = selectModel(config, reviewer.model_tier ?? task.model_tier, reviewer.model);
  const input = await buildReviewerInput(root, task, deliverable);
  const instructions = buildReviewerInstructions(persona, task);
  await saveJson(root, "" + (runDir) + "/review_" + (persona) + "_request_summary.json", {
    model,
    agent_id: reviewer.agent_id,
    task_id: task.task_id,
    reviewer_persona: persona
  });
  const output = await client.createResponse({
    model,
    instructions,
    input,
    maxOutputTokens: config.max_output_tokens
  });
  await incrementMetric(root, "model_calls", estimateModelCostUsd(config, model, output.usage));
  const markdownPath = "" + (runDir) + "/review_" + (persona) + ".md";
  await saveText(root, markdownPath, output.text);
  const parsed = parseReviewerOutput(output.text, persona, task);
  const malformed = parsed.malformed || output.truncated;
  if (malformed) {
    await addChatDefect(
      root,
      task.task_id,
      "Reviewer " + (reviewer.agent_id) + " produced " + (output.truncated ? "truncated" : "malformed") + " structured review output."
    );
  }
  const review = await recordReview(root, {
    taskId: task.task_id,
    reviewerAgentId: reviewer.agent_id,
    reviewerPersona: persona,
    status: malformed ? "abstain" : parsed.status,
    perCriterion: malformed ? [] : parsed.perCriterion,
    identifiedIssues: malformed ? [] : parsed.identifiedIssues,
    freeFormAssessment: malformed ? parsed.freeFormAssessment : parsed.freeFormAssessment,
    malformed: parsed.malformed,
    truncated: output.truncated
  });
  const jsonPath = "" + (runDir) + "/review_" + (persona) + ".json";
  await saveJson(root, jsonPath, review);
  await addArtifact(root, {
    taskId: task.task_id,
    path: markdownPath,
    type: "review_evidence",
    description: "Reviewer " + (persona) + " evidence for " + (task.task_id)
  });
  await addArtifact(root, {
    taskId: task.task_id,
    path: jsonPath,
    type: "structured_review",
    description: "Structured " + (persona) + " review for " + (task.task_id)
  });
}

async function buildReviewerInput(root: string, task: Task, deliverable: Artifact): Promise<string> {
  const reviewTask = {
    ...task,
    title: "Review " + (task.title),
    owner_role: "Reviewer Agent",
    output_required: "Structured review"
  };
  const context = await buildScopedContextPacket(root, reviewTask);
  const deliverableContent = await readArtifactContent(root, deliverable, true);
  return [
    context,
    "--- Dependency Artifact " + (deliverable.artifact_id) + ": " + (deliverable.path) + " ---",
    deliverableContent,
    ""
  ].join("\n");
}

function parseReviewerOutput(
  text: string,
  expectedPersona: ReviewerPersona,
  task: Task
): {
  malformed: boolean;
  status: "pass" | "fail" | "abstain";
  perCriterion: z.infer<typeof ReviewerOutputSchema>["per_criterion"];
  identifiedIssues: z.infer<typeof ReviewerOutputSchema>["identified_issues"];
  freeFormAssessment: string;
} {
  try {
    const parsed = ReviewerOutputSchema.parse(
      normalizeReviewerOutput(JSON.parse(extractJsonText(text)))
    );
    if (parsed.reviewer_persona && parsed.reviewer_persona !== expectedPersona) {
      return malformedReview("Reviewer persona mismatch: " + (parsed.reviewer_persona));
    }
    const expectedCriteria = new Set(task.acceptance_criteria);
    const actualCriteria = parsed.per_criterion.map((entry) => entry.criterion);
    const actualCounts = new Map<string, number>();
    for (const criterion of actualCriteria) {
      actualCounts.set(criterion, (actualCounts.get(criterion) ?? 0) + 1);
    }
    if (
      actualCriteria.length !== task.acceptance_criteria.length ||
      actualCriteria.some((criterion) => !expectedCriteria.has(criterion)) ||
      task.acceptance_criteria.some((criterion) => actualCounts.get(criterion) !== 1)
    ) {
      return malformedReview("Reviewer criteria did not match the task acceptance criteria.");
    }
    return {
      malformed: false,
      status: deriveReviewStatus(parsed.per_criterion),
      perCriterion: parsed.per_criterion,
      identifiedIssues: parsed.identified_issues,
      freeFormAssessment: parsed.free_form_assessment
    };
  } catch (error) {
    return malformedReview(error instanceof Error ? error.message : String(error));
  }
}

function normalizeReviewerOutput(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const issues = value.identified_issues;
  if (!Array.isArray(issues)) return value;
  return {
    ...value,
    identified_issues: issues.map((issue, index) => normalizeReviewIssue(issue, index))
  };
}

function normalizeReviewIssue(value: unknown, index: number): unknown {
  if (!isRecord(value)) return value;
  const citations = Array.isArray(value.citations) ? value.citations : [];
  const description =
    stringField(value, "description") ??
    stringField(value, "issue") ??
    stringField(value, "message") ??
    stringField(value, "summary") ??
    "Reviewer identified an issue.";

  return {
    ...value,
    issue_id:
      stringField(value, "issue_id") ??
      stringField(value, "issueId") ??
      "RI-" + (String(index + 1).padStart(3, "0")),
    severity: normalizeIssueSeverity(stringField(value, "severity")),
    category: stringField(value, "category") ?? "review_issue",
    description,
    evidence: stringField(value, "evidence") ?? citationEvidence(citations) ?? description,
    recommended_fix:
      stringField(value, "recommended_fix") ??
      stringField(value, "recommendedFix") ??
      "Address the identified review issue and rerun verification."
  };
}

function normalizeIssueSeverity(value: string | undefined): "low" | "medium" | "high" {
  const normalized = value?.toLowerCase();
  if (normalized === "low" || normalized === "medium" || normalized === "high") return normalized;
  if (normalized === "minor") return "low";
  if (normalized === "major" || normalized === "critical" || normalized === "blocker") return "high";
  return "medium";
}

function citationEvidence(citations: unknown[]): string | undefined {
  const ranges = citations
    .map((citation) => {
      if (!isRecord(citation)) return undefined;
      const artifactId = stringField(citation, "artifact_id");
      const lineStart = numberField(citation, "line_start");
      const lineEnd = numberField(citation, "line_end");
      if (!artifactId || lineStart === undefined || lineEnd === undefined) return undefined;
      return "" + (artifactId) + ":L" + (lineStart) + "-L" + (lineEnd);
    })
    .filter((range): range is string => Boolean(range));
  return ranges.length > 0 ? "Cited artifact ranges: " + (ranges.join(", ")) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.trim().length > 0 ? field : undefined;
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key];
  return typeof field === "number" ? field : undefined;
}

function malformedReview(reason: string): ReturnType<typeof parseReviewerOutput> {
  return {
    malformed: true,
    status: "abstain",
    perCriterion: [],
    identifiedIssues: [],
    freeFormAssessment: reason
  };
}

function deriveReviewStatus(perCriterion: Array<z.infer<typeof PerCriterionVerdictSchema>>): "pass" | "fail" | "abstain" {
  if (perCriterion.length === 0) return "abstain";
  if (perCriterion.some((entry) => entry.verdict === "fail")) return "fail";
  if (perCriterion.every((entry) => entry.verdict === "pass")) return "pass";
  return "abstain";
}

function extractJsonText(text: string): string {
  const trimmed = text.trim();
  const fenced = /^\x60\x60\x60(?:json)?\s*([\s\S]*?)\s*\x60\x60\x60$/i.exec(trimmed);
  return fenced?.[1] ?? trimmed;
}

async function buildDelegationPacket(
  root: string,
  task: Task,
  assignment: DeploymentAssignment,
  agent: Agent
): Promise<string> {
  const acceptanceContract = buildAcceptanceContract(task);
  return [
    "TASK: " + (task.title),
    "ROLE: " + (task.owner_role),
    "GOAL: " + (task.output_required),
    "INPUTS: " + (task.input_context.length > 0 ? task.input_context.join(", ") : "none"),
    "DO NOT USE: Full conversation history, unlisted state files, external actions without approval.",
    "OUTPUT FORMAT: " + (task.output_required),
    "ACCEPTANCE CRITERIA:",
    ...task.acceptance_criteria.map((criterion) => "- " + (criterion)),
    ...(acceptanceContract.length > 0 ? ["", "ACCEPTANCE CONTRACT:", ...acceptanceContract] : []),
    "KNOWN RISKS: " + (task.risk_level),
    "DEPENDENCIES: " + (task.dependencies.length > 0 ? task.dependencies.join(", ") : "none"),
    "REPORTING CHANNEL: artifacts/runs/" + (task.task_id),
    "ASSIGNED AGENT: " + (assignment.agent_id),
    "EXECUTOR: " + (assignment.executor),
    "MODEL TIER: " + (assignment.model_tier),
    "ROUTING REASON: " + (assignment.reason),
    "AGENT PERMISSIONS: " + (JSON.stringify(agent.permissions))
  ].join("\n");
}

async function buildScopedContextPacket(root: string, task: Task): Promise<string> {
  const lineNumberDependencyArtifacts = isReviewOrSynthesisTask(task);
  const acceptanceContract = buildAcceptanceContract(task);
  const sections = [
    "TASK: " + (task.title),
    "TASK ID: " + (task.task_id),
    "ROLE: " + (task.owner_role),
    "OUTPUT REQUIRED: " + (task.output_required),
    "ACCEPTANCE CRITERIA:",
    ...task.acceptance_criteria.map((criterion) => "- " + (criterion)),
    ...(acceptanceContract.length > 0 ? ["", "ACCEPTANCE CONTRACT:", ...acceptanceContract] : []),
    "",
    "HALT PROTOCOL:",
    "- If you determine the task is impossible, unsafe, contradictory, or that further iteration would not improve the outcome, respond with a single line at the very top of your response:",
    "    HALT: <one-sentence reason>",
    "- The runner will mark the task blocked, preserve your full reasoning as a model_halt artifact, and route the operator to repair the underlying cause.",
    "- Do not emit HALT speculatively. Only refuse when you have grounded reasons (contradictory data, missing inputs, scope drift, or a verifiable impossibility).",
    "- Do not embed HALT mid-response; only the first non-empty line counts.",
    ""
  ];
  for (const contextPath of task.input_context) {
    const safePath = resolveSafe(root, contextPath);
    const content = await readFile(safePath, "utf8");
    sections.push("--- " + (contextPath) + " ---", content, "");
  }
  const dependencyArtifacts = await collectDependencyArtifacts(root, task);
  for (const artifact of dependencyArtifacts) {
    const content = await readArtifactContent(root, artifact, lineNumberDependencyArtifacts);
    sections.push("--- Dependency Artifact " + (artifact.artifact_id) + ": " + (artifact.path) + " ---", content, "");
  }
  return sections.join("\n");
}

function buildAcceptanceContract(task: Task): string[] {
  const guidance = new Set<string>();
  for (const criterion of task.acceptance_criteria) {
    const normalized = criterion.toLowerCase();
    if (
      normalized.includes("tradeoff") &&
      normalized.includes("latency") &&
      normalized.includes("cost") &&
      normalized.includes("reliability")
    ) {
      guidance.add(
        "- For every option/pattern/architecture you list, include separate Tradeoffs bullets for Latency, Cost, and Reliability."
      );
      guidance.add("- Do not combine required dimensions into one bullet.");
      guidance.add("- Do not write N/A for Latency, Cost, or Reliability.");
      guidance.add("- If a dimension is offline or indirect, state the concrete impact instead.");
    }
    if (
      normalized.includes("roadmap") &&
      normalized.includes("milestone") &&
      normalized.includes("dependenc") &&
      (normalized.includes("evaluation gate") || normalized.includes("gate"))
    ) {
      guidance.add(
        "- For every roadmap phase or milestone, include explicit Dependencies and Evaluation gate/exit criteria."
      );
      guidance.add("- Include inter-milestone dependency order or critical path where milestones build on each other.");
    }
  }
  return Array.from(guidance);
}

function normalizeModelOutputForAcceptance(task: Task, text: string): string {
  if (!requiresExplicitTradeoffDimensions(task)) return text;
  return text
    .split("\n")
    .map((line) => line.replace(/^(\s*-\s*)(Latency|Cost|Reliability):\s*/i, (_match, prefix: string, dimension: string) => {
      return "" + (prefix) + "Tradeoffs — " + (normalizeTradeoffDimension(dimension)) + ": ";
    }))
    .join("\n");
}

function requiresExplicitTradeoffDimensions(task: Task): boolean {
  return task.acceptance_criteria.some((criterion) => {
    const normalized = criterion.toLowerCase();
    return (
      normalized.includes("tradeoff") &&
      normalized.includes("latency") &&
      normalized.includes("cost") &&
      normalized.includes("reliability")
    );
  });
}

function normalizeTradeoffDimension(dimension: string): string {
  const normalized = dimension.toLowerCase();
  if (normalized === "latency") return "Latency";
  if (normalized === "cost") return "Cost";
  return "Reliability";
}

async function readArtifactContent(root: string, artifact: Artifact, lineNumbered: boolean): Promise<string> {
  const safePath = resolveSafe(root, artifact.path);
  const content = await readFile(safePath, "utf8");
  return lineNumbered ? lineNumberContent(content) : content;
}

function lineNumberContent(content: string): string {
  const normalized = content.endsWith("\n") ? content.slice(0, -1) : content;
  return normalized
    .split("\n")
    .map((line, index) => "L" + (String(index + 1).padStart(3, "0")) + ": " + (line))
    .join("\n");
}

async function collectDependencyArtifacts(root: string, task: Task) {
  const board = TaskBoardSchema.parse(await loadJson(root, "state/task_board.json"));
  const index = ArtifactIndexSchema.parse(await loadJson(root, "artifacts/artifact_index.json"));
  const visited = new Set<string>();
  const orderedTaskIds: string[] = [];

  function visit(taskId: string): void {
    if (visited.has(taskId)) return;
    visited.add(taskId);
    const dependencyTask = board.tasks.find((entry) => entry.task_id === taskId);
    if (!dependencyTask) return;
    for (const dependency of dependencyTask.dependencies) visit(dependency);
    orderedTaskIds.push(taskId);
  }

  for (const dependency of task.dependencies) visit(dependency);
  return orderedTaskIds.flatMap((taskId) =>
    index.artifacts.filter((artifact) => artifact.task_id === taskId)
  );
}

function resolveSafe(root: string, relativePath: string): string {
  const normalized = normalize(relativePath);
  const absolute = resolve(root, normalized);
  const workspace = resolve(root);
  if (relative(workspace, absolute).startsWith("..")) {
    throw new Error("Context path escapes workspace: " + (relativePath));
  }
  return absolute;
}

async function markTask(
  board: { tasks: Task[] },
  root: string,
  task: Task,
  status: Task["status"],
  blocker?: string
): Promise<void> {
  task.status = status;
  task.updated_at = nowIso();
  if (status === "running" || status === "completed" || status === "approved") task.blocker = undefined;
  if (blocker) task.blocker = blocker;
  await saveJson(root, "state/task_board.json", board);
  if (status === "completed" || status === "approved") {
    await resolveChatBlockers(root, task.task_id);
  }
  if (status === "completed") await incrementMetric(root, "tasks_completed");
  if (status === "failed") await incrementMetric(root, "tasks_failed");
}

async function resolveChatBlockers(root: string, taskId: string): Promise<void> {
  const chat = ChatStoreSchema.parse(await loadJson(root, "state/chat.json"));
  const resolvedAt = nowIso().replace(/\.\d{3}Z$/, "Z");
  let changed = false;
  for (const message of chat.messages) {
    if (message.task_id !== taskId || message.type !== "blocker" || !message.requires_action) continue;
    message.requires_action = false;
    message.summary = "[RESOLVED " + (resolvedAt) + "] " + (message.summary);
    changed = true;
  }
  if (changed) await saveJson(root, "state/chat.json", chat);
}

async function addChatHalt(root: string, taskId: string, reason: string): Promise<void> {
  const chat = ChatStoreSchema.parse(await loadJson(root, "state/chat.json"));
  chat.messages.push({
    message_id: nextId(
      "M",
      chat.messages.map((entry) => entry.message_id)
    ),
    timestamp: nowIso(),
    from_agent: "runner",
    to: "orchestrator",
    type: "blocker",
    task_id: taskId,
    summary: "Model halted task " + taskId + ": " + reason,
    details:
      "The model emitted a HALT signal at the start of its response. The full reasoning is preserved at artifacts/runs/" +
      taskId +
      "/response_output.md as a model_halt artifact (not counted as a deliverable).",
    requires_action: true,
    recommended_next_step:
      "Inspect the HALT reason and repair the underlying cause (data, registry, intent, or constraints). Then re-run with --rerun. If the HALT is a correct refusal, revise the plan or close the workflow rather than overriding."
  });
  await saveJson(root, "state/chat.json", chat);
}

async function addChatBlocker(root: string, taskId: string, message: string): Promise<void> {
  const chat = ChatStoreSchema.parse(await loadJson(root, "state/chat.json"));
  chat.messages.push({
    message_id: nextId(
      "M",
      chat.messages.map((entry) => entry.message_id)
    ),
    timestamp: nowIso(),
    from_agent: "runner",
    to: "orchestrator",
    type: "blocker",
    task_id: taskId,
    summary: message,
    details: message,
    requires_action: true,
    recommended_next_step: "Inspect task failure and re-run after correction."
  });
  await saveJson(root, "state/chat.json", chat);
}

async function addChatDefect(root: string, taskId: string, message: string): Promise<void> {
  const chat = ChatStoreSchema.parse(await loadJson(root, "state/chat.json"));
  chat.messages.push({
    message_id: nextId(
      "M",
      chat.messages.map((entry) => entry.message_id)
    ),
    timestamp: nowIso(),
    from_agent: "runner",
    to: "orchestrator",
    type: "defect",
    task_id: taskId,
    summary: message,
    details: message,
    requires_action: false,
    recommended_next_step: "Inspect structured review artifacts and consensus."
  });
  await saveJson(root, "state/chat.json", chat);
}

async function spawnCommand(
  command: string,
  args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (exitCode) => resolvePromise({ stdout, stderr, exitCode }));
  });
}
