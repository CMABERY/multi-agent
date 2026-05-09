import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { z, ZodTypeAny } from "zod";
import { readOperatorState, type OperatorCondition, type OperatorState } from "./operatorState.js";
import {
  AgentRegistrySchema,
  ChatStoreSchema,
  ContextCheckStoreSchema,
  DeploymentPlanStoreSchema,
  ModelConfigSchema,
  PlanCheckStoreSchema,
  TaskBoardSchema,
  type Agent,
  type ContextCheckStore,
  type DeploymentPlan,
  type ModelConfig,
  type PlanCheck,
  type PlanCheckStore,
  type Task
} from "./schemas.js";

export interface DoctorFinding {
  code: string;
  severity: "low" | "medium" | "high";
  message: string;
  repair: string;
  target?: string;
}

export interface DoctorReport {
  summary: "issues_found" | "no_issues_found";
  workflow_state: OperatorState["workflow_state"];
  findings: DoctorFinding[];
  state_safety: string;
  recommended_next_command: string;
  recommended_next_reason: string;
}

type AgentRegistry = z.infer<typeof AgentRegistrySchema>;
type ChatStore = z.infer<typeof ChatStoreSchema>;
type DeploymentPlanStore = z.infer<typeof DeploymentPlanStoreSchema>;
type TaskBoard = z.infer<typeof TaskBoardSchema>;

type SafeRead<T> =
  | { kind: "ok"; value: T }
  | { kind: "missing" }
  | { kind: "invalid" };

export async function runOperatorDoctor(root: string): Promise<DoctorReport> {
  const operatorState = await readOperatorState(root);
  const findings: DoctorFinding[] = [];

  for (const blocker of operatorState.blockers) {
    if (blocker.code === "CHAT_REQUIRES_ACTION") continue;
    findings.push(findingFromCondition(blocker, operatorState));
  }
  for (const condition of operatorState.stale_conditions) {
    findings.push(findingFromCondition(condition, operatorState));
  }
  for (const condition of operatorState.risky_conditions) {
    findings.push(findingFromCondition(condition, operatorState));
  }

  await addModelConfigFindings(root, findings);
  await addReviewerCoverageFindings(root, findings);
  await addLocalCommandFindings(root, findings);
  await addChatFindings(root, findings);
  await addPlanCheckFindings(root, operatorState, findings);
  await addContextCheckFindings(root, findings);

  const deduped = dedupeFindings(findings);
  return {
    summary: deduped.length > 0 ? "issues_found" : "no_issues_found",
    workflow_state: operatorState.workflow_state,
    findings: deduped,
    state_safety: "no production command was run; state was not modified.",
    recommended_next_command: operatorState.recommended_next_command,
    recommended_next_reason: operatorState.recommended_next_reason
  };
}

export function renderDoctorReport(report: DoctorReport): string {
  return [
    "Doctor Summary: " + report.summary,
    "Workflow State: " + report.workflow_state,
    "",
    "Findings:",
    ...(report.findings.length === 0
      ? ["- none"]
      : report.findings.flatMap((finding) => [
          "- " + formatFindingHeader(finding),
          "  Repair: " + finding.repair
        ])),
    "",
    "State Safety: " + report.state_safety,
    "Next: " + report.recommended_next_command,
    "Reason: " + report.recommended_next_reason
  ].join("\n");
}

function findingFromCondition(condition: OperatorCondition, state: OperatorState): DoctorFinding {
  return {
    code: condition.code,
    severity: condition.severity,
    target: condition.target,
    message: condition.message,
    repair: repairForCondition(condition, state)
  };
}

function repairForCondition(condition: OperatorCondition, state: OperatorState): string {
  const deploymentId = state.active_deployment_id ?? "DP-001";
  if (condition.code === "WORKSPACE_FILE_MISSING") return "run maw init.";
  if (condition.code === "STATE_FILE_INVALID") return "repair the listed JSON file, then run maw doctor again.";
  if (condition.code === "TASK_FAILED" || condition.code === "TASK_BLOCKED") {
    return "inspect task blocker, fix the cause, then run maw run --deployment " + deploymentId + " --rerun.";
  }
  if (condition.code === "PLAN_CHECK_MISSING" || condition.code === "PLAN_CHECK_STALE") {
    return "run maw plan-check --deployment " + deploymentId + ".";
  }
  if (condition.code === "PLAN_CHECK_HIGH_SEVERITY") {
    return "inspect plan-check issues, repair the deployment plan, then run maw plan-check --deployment " + deploymentId + ".";
  }
  if (condition.code === "APPROVAL_MISSING") {
    return "run maw approval record --deployment " + deploymentId + " --approver \"operator\" --scope \"Run " + deploymentId + " after plan-check review.\"";
  }
  if (condition.code === "VERIFICATION_MISSING") {
    return "run " + state.recommended_next_command + ".";
  }
  if (condition.code === "SCORE_MISSING" || condition.code === "SCORE_STALE") {
    return "run maw score --deployment " + deploymentId + ".";
  }
  if (condition.code === "RETROSPECTIVE_MISSING") {
    return "run maw retrospective --deployment " + deploymentId + ".";
  }
  if (condition.code === "PERFORMANCE_LEDGER_MISSING") {
    return "run maw performance update --deployment " + deploymentId + ".";
  }
  return "inspect this finding, repair the cause, then run maw doctor again.";
}

async function addModelConfigFindings(root: string, findings: DoctorFinding[]): Promise<void> {
  const config = await readSchema<ModelConfig>(root, "state/model_config.json", ModelConfigSchema);
  if (config.kind !== "ok") return;
  if (process.env[config.value.api_key_env]) return;
  findings.push({
    code: "MODEL_API_KEY_MISSING",
    severity: "medium",
    target: config.value.api_key_env,
    message: "Environment variable " + config.value.api_key_env + " is not set for model-backed commands.",
    repair: "set environment variable " + config.value.api_key_env + " before model-backed commands."
  });
}

async function addReviewerCoverageFindings(root: string, findings: DoctorFinding[]): Promise<void> {
  const registry = await readSchema<AgentRegistry>(root, "state/agent_registry.json", AgentRegistrySchema);
  const board = await readSchema<TaskBoard>(root, "state/task_board.json", TaskBoardSchema);
  if (registry.kind !== "ok" || board.kind !== "ok") return;
  const reviewerPersonas = new Set(
    registry.value.agents
      .filter((agent) => agent.role.includes("Reviewer") && agent.reviewer_persona)
      .map((agent) => agent.reviewer_persona)
  );
  for (const task of board.value.tasks) {
    if (task.risk_level !== "high" || !task.review_required) continue;
    if (reviewerPersonas.size >= 3) continue;
    findings.push({
      code: "REVIEWER_COVERAGE_INSUFFICIENT",
      severity: "high",
      target: task.task_id,
      message: "High-risk review-required task " + task.task_id + " has " + reviewerPersonas.size + " reviewer persona(s); 3 required.",
      repair: "register or restore Reviewer agents with distinct reviewer_persona values."
    });
  }
}

async function addLocalCommandFindings(root: string, findings: DoctorFinding[]): Promise<void> {
  const registry = await readSchema<AgentRegistry>(root, "state/agent_registry.json", AgentRegistrySchema);
  const board = await readSchema<TaskBoard>(root, "state/task_board.json", TaskBoardSchema);
  const plans = await readSchema<DeploymentPlanStore>(root, "state/deployment_plan.json", DeploymentPlanStoreSchema);
  if (registry.kind !== "ok" || board.kind !== "ok" || plans.kind !== "ok") return;
  const agents = new Map(registry.value.agents.map((agent) => [agent.agent_id, agent]));
  const tasks = new Map(board.value.tasks.map((task) => [task.task_id, task]));

  for (const plan of plans.value.deployment_plans) {
    if (plan.status === "completed") continue;
    for (const assignment of plan.assignments) {
      if (assignment.executor !== "local_command") continue;
      const task = tasks.get(assignment.task_id);
      const agent = agents.get(assignment.agent_id);
      findings.push({
        code: "LOCAL_COMMAND_REQUIRES_EXECUTE",
        severity: "medium",
        target: assignment.task_id,
        message: "Local command task " + assignment.task_id + " requires --execute when running deployment " + plan.deployment_id + ".",
        repair: "run maw run --deployment " + plan.deployment_id + " --execute after approval."
      });
      if (!task?.command) {
        findings.push({
          code: "LOCAL_COMMAND_MISSING",
          severity: "high",
          target: assignment.task_id,
          message: "Local command task " + assignment.task_id + " does not define a command.",
          repair: "add a command spec or reroute the task to another executor."
        });
        continue;
      }
      if (!agent || !agent.command_allowlist.includes(task.command.command)) {
        findings.push({
          code: "LOCAL_COMMAND_NOT_ALLOWLISTED",
          severity: "high",
          target: assignment.task_id + "/" + task.command.command,
          message: "Command " + task.command.command + " is not allowlisted for " + assignment.agent_id + ".",
          repair: "add the command to the assigned agent allowlist or reroute the task."
        });
      }
    }
  }
}

async function addChatFindings(root: string, findings: DoctorFinding[]): Promise<void> {
  const chat = await readSchema<ChatStore>(root, "state/chat.json", ChatStoreSchema);
  if (chat.kind !== "ok") return;
  for (const message of chat.value.messages.filter((entry) => entry.requires_action)) {
    findings.push({
      code: "CHAT_REQUIRES_ACTION",
      severity: "high",
      target: message.task_id ?? message.message_id,
      message: "Action required from chat " + message.message_id + ": " + message.summary,
      repair: message.recommended_next_step
        ? "follow the recorded next step: " + message.recommended_next_step
        : "inspect state/chat.json and resolve the action-required message."
    });
  }
}

async function addPlanCheckFindings(
  root: string,
  state: OperatorState,
  findings: DoctorFinding[]
): Promise<void> {
  const checks = await readSchema<PlanCheckStore>(root, "state/plan_checks.json", PlanCheckStoreSchema);
  if (checks.kind !== "ok" || !state.active_deployment_id) return;
  const check = latestPlanCheck(checks.value, state.active_deployment_id);
  if (!check || check.status !== "fail") return;
  for (const issue of check.issues.filter((entry) => entry.severity === "high")) {
    findings.push({
      code: "PLAN_CHECK_HIGH_SEVERITY",
      severity: "high",
      target: issue.target,
      message: issue.code + ": " + issue.message,
      repair: issue.recommended_fix + " Then run maw plan-check --deployment " + state.active_deployment_id + "."
    });
  }
}

async function addContextCheckFindings(root: string, findings: DoctorFinding[]): Promise<void> {
  const checks = await readSchema<ContextCheckStore>(root, "state/context_checks.json", ContextCheckStoreSchema);
  if (checks.kind !== "ok") return;
  for (const check of checks.value.context_checks.filter((entry) => entry.status === "fail")) {
    const firstIssue = check.issues[0];
    findings.push({
      code: "CONTEXT_CHECK_FAILED",
      severity: firstIssue?.severity ?? "medium",
      target: check.task_id,
      message: "Context check " + check.check_id + " failed for task " + check.task_id + (firstIssue ? ": " + firstIssue.message : "."),
      repair: firstIssue
        ? firstIssue.recommended_fix + " Then run maw context-check --task " + check.task_id + "."
        : "inspect context check issues, repair the task context, then run maw context-check --task " + check.task_id + "."
    });
  }
}

async function readSchema<T>(root: string, relativePath: string, schema: ZodTypeAny): Promise<SafeRead<T>> {
  let raw = "";
  try {
    raw = await readFile(join(root, relativePath), "utf8");
  } catch {
    return { kind: "missing" };
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return { kind: "invalid" };
  }
  const parsed = schema.safeParse(parsedJson);
  if (!parsed.success) return { kind: "invalid" };
  return { kind: "ok", value: parsed.data };
}

function latestPlanCheck(store: PlanCheckStore, deploymentId: string): PlanCheck | undefined {
  return [...store.plan_checks]
    .filter((check) => check.deployment_id === deploymentId)
    .sort((left, right) => {
      const timeDiff = timestampValue(right.updated_at ?? right.created_at) - timestampValue(left.updated_at ?? left.created_at);
      if (timeDiff !== 0) return timeDiff;
      return right.check_id.localeCompare(left.check_id);
    })[0];
}

function timestampValue(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function dedupeFindings(findings: DoctorFinding[]): DoctorFinding[] {
  const seen = new Set<string>();
  const deduped: DoctorFinding[] = [];
  for (const finding of findings) {
    const key = finding.code + "|" + (finding.target ?? "") + "|" + finding.message;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(finding);
  }
  return deduped;
}

function formatFindingHeader(finding: DoctorFinding): string {
  const target = finding.target ? " " + finding.target : "";
  return finding.code + " [" + finding.severity + "]" + target + ": " + finding.message;
}
