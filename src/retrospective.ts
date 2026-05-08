import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { nextId } from "./ids.js";
import { loadDeploymentContext } from "./intelligenceCommon.js";
import { updateAgentPerformance } from "./performance.js";
import { writeWorkflowScore } from "./scoring.js";
import {
  ChatStoreSchema,
  ContextCheckStoreSchema,
  LearningMemorySchema,
  PlanCheckStoreSchema,
  RetrospectiveIndexSchema,
  WorkflowScoreStoreSchema,
  type IntelligenceIssue,
  type LearningRule,
  type Retrospective
} from "./schemas.js";
import { loadJson, loadJsonOrDefault, nowIso, saveJson, saveText } from "./storage.js";

export async function runRetrospective(
  root: string,
  input: { deploymentId: string }
): Promise<Retrospective> {
  const { plan, tasks } = await loadDeploymentContext(root, input.deploymentId);
  const score = await ensureScore(root, plan.deployment_id);
  const planChecks = PlanCheckStoreSchema.parse(
    await loadJsonOrDefault(root, "state/plan_checks.json", { plan_checks: [] })
  );
  const contextChecks = ContextCheckStoreSchema.parse(
    await loadJsonOrDefault(root, "state/context_checks.json", { context_checks: [] })
  );
  const chat = ChatStoreSchema.parse(await loadJson(root, "state/chat.json"));
  const memory = LearningMemorySchema.parse(
    await loadJsonOrDefault(root, "state/learning_memory.json", { learning_rules: [] })
  );
  const retrospectiveIndex = RetrospectiveIndexSchema.parse(
    await loadJsonOrDefault(root, "state/retrospective_index.json", { retrospectives: [] })
  );

  const relevantPlanIssues = planChecks.plan_checks
    .filter((check) => check.deployment_id === plan.deployment_id)
    .flatMap((check) => check.issues);
  const taskIds = new Set(tasks.map((task) => task.task_id));
  const relevantContextIssues = contextChecks.context_checks
    .filter((check) => taskIds.has(check.task_id))
    .flatMap((check) => check.issues);
  const blockers = chat.messages.filter(
    (message) => message.type === "blocker" && (!message.task_id || taskIds.has(message.task_id))
  );
  const learnedRuleIds = upsertLearningRules(
    memory.learning_rules,
    [...relevantPlanIssues, ...relevantContextIssues],
    plan.deployment_id
  );

  await updateAgentPerformance(root, { deploymentId: plan.deployment_id });
  await saveJson(root, "state/learning_memory.json", memory);

  const now = nowIso();
  const existingIndex = retrospectiveIndex.retrospectives.findIndex(
    (entry) => entry.deployment_id === plan.deployment_id
  );
  const existing = existingIndex >= 0 ? retrospectiveIndex.retrospectives[existingIndex] : undefined;
  const retrospectiveId =
    existing?.retrospective_id ??
    nextId(
      "RET",
      retrospectiveIndex.retrospectives.map((entry) => entry.retrospective_id)
    );
  const path = existing?.path ?? `state/retrospectives/${retrospectiveId}.md`;
  await mkdir(join(root, "state/retrospectives"), { recursive: true });
  await saveText(
    root,
    path,
    renderRetrospectiveMarkdown({
      retrospectiveId,
      deploymentId: plan.deployment_id,
      score,
      planIssues: relevantPlanIssues,
      contextIssues: relevantContextIssues,
      blockers: blockers.map((message) => message.summary),
      learnedRuleIds
    })
  );
  const indexEntry = {
    retrospective_id: retrospectiveId,
    deployment_id: plan.deployment_id,
    path,
    created_at: existing?.created_at ?? now,
    updated_at: now
  };
  if (existingIndex >= 0) retrospectiveIndex.retrospectives[existingIndex] = indexEntry;
  else retrospectiveIndex.retrospectives.push(indexEntry);
  await saveJson(root, "state/retrospective_index.json", retrospectiveIndex);

  return {
    retrospective_id: retrospectiveId,
    deployment_id: plan.deployment_id,
    path,
    learned_rule_ids: learnedRuleIds,
    created_at: indexEntry.created_at
  };
}

async function ensureScore(root: string, deploymentId: string) {
  const store = WorkflowScoreStoreSchema.parse(
    await loadJsonOrDefault(root, "state/workflow_score.json", { workflow_scores: [] })
  );
  return (
    store.workflow_scores.find((entry) => entry.deployment_id === deploymentId) ??
    (await writeWorkflowScore(root, { deploymentId }))
  );
}

function upsertLearningRules(
  rules: LearningRule[],
  issues: IntelligenceIssue[],
  deploymentId: string
): string[] {
  const learnedRuleIds: string[] = [];
  const now = nowIso();
  for (const issue of issues.filter((entry) => entry.severity === "high" || entry.severity === "medium")) {
    const ruleText = ruleForIssue(issue);
    const source = `${deploymentId}/${issue.target}/${issue.code}`;
    const existing = rules.find((rule) => rule.trigger === issue.code && rule.rule === ruleText);
    if (existing) {
      existing.sources_seen ??= [];
      if (!existing.sources_seen.includes(source)) {
        existing.sources_seen.push(source);
        existing.times_seen += 1;
        existing.last_seen_at = now;
      }
      learnedRuleIds.push(existing.rule_id);
      continue;
    }
    const rule: LearningRule = {
      rule_id: nextId(
        "LR",
        rules.map((entry) => entry.rule_id)
      ),
      trigger: issue.code,
      rule: ruleText,
      source,
      confidence: 0.8,
      created_at: now,
      last_seen_at: now,
      times_seen: 1,
      sources_seen: [source]
    };
    rules.push(rule);
    learnedRuleIds.push(rule.rule_id);
  }
  return learnedRuleIds;
}

function ruleForIssue(issue: IntelligenceIssue): string {
  if (issue.code === "DRY_RUN_DELIVERABLE") {
    return "Do not route deliverable tasks to dry_run unless the required output is only a delegation packet.";
  }
  if (issue.code.includes("ARTIFACT")) {
    return "Reviewer and synthesizer tasks must receive readable indexed artifacts from all dependency tasks.";
  }
  if (issue.code === "EXECUTOR_REGISTRY_MISMATCH") {
    return "Deployment assignments must match the executor type registered for the selected agent.";
  }
  if (issue.code === "INSUFFICIENT_REVIEWERS") {
    return "High-risk reviewable tasks require at least three distinct reviewer personas in the registry.";
  }
  if (issue.code === "UNTESTABLE_ACCEPTANCE_CRITERIA") {
    return "Acceptance criteria must be written as observable, evidence-checkable predicates.";
  }
  if (issue.code === "NO_DELIVERABLE_ARTIFACT") {
    return "Review-required tasks must produce a citable model_output or command_output artifact.";
  }
  if (issue.code === "LOW_REVIEW_PASS_RATE_FOR_RISK") {
    return "Do not route high-risk reviewable tasks to agents whose review pass rate is below the configured floor.";
  }
  if (issue.code === "HIGH_FAILURE_RATE_AGENT") {
    return "Do not route non-low-risk tasks to agents whose failure rate exceeds the configured ceiling.";
  }
  return issue.recommended_fix;
}

function renderRetrospectiveMarkdown(input: {
  retrospectiveId: string;
  deploymentId: string;
  score: { workflow_intelligence_yield: number; verified_useful_outputs: number };
  planIssues: IntelligenceIssue[];
  contextIssues: IntelligenceIssue[];
  blockers: string[];
  learnedRuleIds: string[];
}): string {
  return [
    `# Retrospective ${input.retrospectiveId}`,
    "",
    `Deployment: ${input.deploymentId}`,
    `Workflow Intelligence Yield: ${input.score.workflow_intelligence_yield}`,
    `Verified Useful Outputs: ${input.score.verified_useful_outputs}`,
    "",
    "## Plan Issues",
    ...(input.planIssues.length === 0
      ? ["- None"]
      : input.planIssues.map((issue) => `- ${issue.code} [${issue.severity}] ${issue.target}: ${issue.message}`)),
    "",
    "## Context Issues",
    ...(input.contextIssues.length === 0
      ? ["- None"]
      : input.contextIssues.map((issue) => `- ${issue.code} [${issue.severity}] ${issue.target}: ${issue.message}`)),
    "",
    "## Blockers",
    ...(input.blockers.length === 0 ? ["- None"] : input.blockers.map((blocker) => `- ${blocker}`)),
    "",
    "## Learned Rules",
    ...(input.learnedRuleIds.length === 0 ? ["- None"] : input.learnedRuleIds.map((id) => `- ${id}`)),
    ""
  ].join("\n");
}
