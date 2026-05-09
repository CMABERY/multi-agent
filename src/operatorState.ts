import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { z, ZodTypeAny } from "zod";
import {
  AgentRegistrySchema,
  ApprovalStoreSchema,
  ArtifactIndexSchema,
  ChatStoreSchema,
  ConsensusStoreSchema,
  ContextCheckStoreSchema,
  DeploymentPlanStoreSchema,
  IntentQueueSchema,
  LearningMemorySchema,
  MetricsSchema,
  ModelConfigSchema,
  PerformanceLedgerSchema,
  PlanCheckStoreSchema,
  RetrospectiveIndexSchema,
  ReviewLogSchema,
  TaskBoardSchema,
  WorkflowScoreStoreSchema,
  type ApprovalStore,
  type Consensus,
  type ConsensusStore,
  type DeploymentPlan,
  type Intent,
  type PerformanceLedger,
  type PlanCheck,
  type PlanCheckStore,
  type RetrospectiveIndex,
  type Task,
  type WorkflowScore,
  type WorkflowScoreStore
} from "./schemas.js";

export type OperatorWorkflowState =
  | "uninitialized"
  | "state_invalid"
  | "idle"
  | "planning_needed"
  | "approval_precheck_needed"
  | "approval_needed"
  | "execution_ready"
  | "execution_in_progress"
  | "blocked"
  | "failed"
  | "verification_needed"
  | "scoring_needed"
  | "retrospective_needed"
  | "performance_update_needed"
  | "complete";

export interface OperatorCondition {
  code: string;
  message: string;
  target?: string;
  severity: "low" | "medium" | "high";
}

export interface OperatorReadiness {
  workspace_initialized: boolean;
  state_valid: boolean;
  has_active_intent: boolean;
  has_active_deployment: boolean;
  plan_check_current: boolean;
  plan_check_passed: boolean;
  approval_present: boolean;
  execution_ready: boolean;
  verification_complete: boolean;
  score_current: boolean;
  retrospective_present: boolean;
  performance_current: boolean;
}

export interface OperatorState {
  workflow_state: OperatorWorkflowState;
  active_intent_id?: string;
  active_deployment_id?: string;
  active_task_id?: string;
  blockers: OperatorCondition[];
  readiness: OperatorReadiness;
  stale_conditions: OperatorCondition[];
  risky_conditions: OperatorCondition[];
  recommended_next_command: string;
  recommended_next_reason: string;
}

interface WorkspaceState {
  intents: Intent[];
  tasks: Task[];
  deployments: DeploymentPlan[];
  approvals: ApprovalStore;
  reviews: ReviewLog;
  consensus: ConsensusStore;
  scores: WorkflowScoreStore;
  planChecks: PlanCheckStore;
  retrospectives: RetrospectiveIndex;
  performance: PerformanceLedger;
  chat: ChatStore;
}

type ReadResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "missing"; path: string }
  | { kind: "invalid"; path: string; message: string };

interface StoreSpec<T> {
  key: string;
  path: string;
  schema: ZodTypeAny;
}

type ChatStore = z.infer<typeof ChatStoreSchema>;
type ReviewLog = z.infer<typeof ReviewLogSchema>;

type Stores = {
  agentRegistry: unknown;
  artifactIndex: unknown;
  approvals: ApprovalStore;
  chat: ChatStore;
  consensus: ConsensusStore;
  contextChecks: unknown;
  deployments: { deployment_plans: DeploymentPlan[] };
  intents: { intents: Intent[] };
  learningMemory: unknown;
  metrics: unknown;
  modelConfig: unknown;
  performance: PerformanceLedger;
  planChecks: PlanCheckStore;
  retrospectives: RetrospectiveIndex;
  reviews: ReviewLog;
  scores: WorkflowScoreStore;
  tasks: { tasks: Task[] };
};

const storeSpecs: { [K in keyof Stores]: StoreSpec<Stores[K]> } = {
  agentRegistry: { key: "agentRegistry", path: "state/agent_registry.json", schema: AgentRegistrySchema },
  artifactIndex: { key: "artifactIndex", path: "artifacts/artifact_index.json", schema: ArtifactIndexSchema },
  approvals: { key: "approvals", path: "state/approvals.json", schema: ApprovalStoreSchema },
  chat: { key: "chat", path: "state/chat.json", schema: ChatStoreSchema },
  consensus: { key: "consensus", path: "state/consensus.json", schema: ConsensusStoreSchema },
  contextChecks: { key: "contextChecks", path: "state/context_checks.json", schema: ContextCheckStoreSchema },
  deployments: { key: "deployments", path: "state/deployment_plan.json", schema: DeploymentPlanStoreSchema },
  intents: { key: "intents", path: "state/intent_queue.json", schema: IntentQueueSchema },
  learningMemory: { key: "learningMemory", path: "state/learning_memory.json", schema: LearningMemorySchema },
  metrics: { key: "metrics", path: "state/metrics.json", schema: MetricsSchema },
  modelConfig: { key: "modelConfig", path: "state/model_config.json", schema: ModelConfigSchema },
  performance: { key: "performance", path: "state/performance_ledger.json", schema: PerformanceLedgerSchema },
  planChecks: { key: "planChecks", path: "state/plan_checks.json", schema: PlanCheckStoreSchema },
  retrospectives: { key: "retrospectives", path: "state/retrospective_index.json", schema: RetrospectiveIndexSchema },
  reviews: { key: "reviews", path: "state/review_log.json", schema: ReviewLogSchema },
  scores: { key: "scores", path: "state/workflow_score.json", schema: WorkflowScoreStoreSchema },
  tasks: { key: "tasks", path: "state/task_board.json", schema: TaskBoardSchema }
};

const activeDeploymentStatuses = new Set(["running", "failed", "blocked", "approved", "proposed"]);

export async function resolveActiveDeploymentId(
  root: string,
  explicit: string | undefined
): Promise<string> {
  if (typeof explicit === "string" && explicit.trim().length > 0) return explicit.trim();
  const state = await readOperatorState(root);
  if (state.active_deployment_id) return state.active_deployment_id;
  throw new Error(
    "No active deployment. Pass --deployment <id> or run maw status to inspect deployments."
  );
}

export async function resolveActiveIntentId(
  root: string,
  explicit: string | undefined
): Promise<string> {
  if (typeof explicit === "string" && explicit.trim().length > 0) return explicit.trim();
  const state = await readOperatorState(root);
  if (state.active_intent_id) return state.active_intent_id;
  throw new Error(
    "No active intent. Pass --intent <id> or run maw status to inspect intents."
  );
}

export async function resolveActiveTaskId(
  root: string,
  explicit: string | undefined
): Promise<string> {
  if (typeof explicit === "string" && explicit.trim().length > 0) return explicit.trim();
  const state = await readOperatorState(root);
  if (state.active_task_id) return state.active_task_id;
  throw new Error(
    "No active task. Pass --task <id> or run maw status to inspect tasks."
  );
}

export async function readOperatorState(root: string): Promise<OperatorState> {
  const loaded = await loadStores(root);
  if (loaded.kind === "uninitialized") {
    return baseState({
      workflow_state: "uninitialized",
      blockers: loaded.missing.map((path) =>
        condition("WORKSPACE_FILE_MISSING", "Workspace file is missing: " + path + ".", path, "high")
      ),
      readiness: { workspace_initialized: false, state_valid: false },
      recommended_next_command: "maw init",
      recommended_next_reason: "workspace files are missing."
    });
  }
  if (loaded.kind === "invalid") {
    return baseState({
      workflow_state: "state_invalid",
      blockers: loaded.invalid.map((entry) =>
        condition("STATE_FILE_INVALID", entry.path + " could not be parsed or did not match schema: " + entry.message, entry.path, "high")
      ),
      readiness: { workspace_initialized: true, state_valid: false },
      recommended_next_command: "maw doctor",
      recommended_next_reason: "state files could not be parsed or did not match schema."
    });
  }

  return interpretState({
    intents: loaded.stores.intents.intents,
    tasks: loaded.stores.tasks.tasks,
    deployments: loaded.stores.deployments.deployment_plans,
    approvals: loaded.stores.approvals,
    reviews: loaded.stores.reviews,
    consensus: loaded.stores.consensus,
    scores: loaded.stores.scores,
    planChecks: loaded.stores.planChecks,
    retrospectives: loaded.stores.retrospectives,
    performance: loaded.stores.performance,
    chat: loaded.stores.chat
  });
}

async function loadStores(root: string): Promise<
  | { kind: "ok"; stores: Stores }
  | { kind: "uninitialized"; missing: string[] }
  | { kind: "invalid"; invalid: Array<{ path: string; message: string }> }
> {
  const entries = await Promise.all(
    (Object.keys(storeSpecs) as Array<keyof Stores>).map(async (key) => {
      const spec = storeSpecs[key];
      return [key, await readStore(root, spec.path, spec.schema)] as const;
    })
  );
  const missing = entries
    .map(([, result]) => (result.kind === "missing" ? result.path : undefined))
    .filter((path): path is string => Boolean(path));
  if (missing.length > 0) return { kind: "uninitialized", missing };

  const invalid = entries
    .map(([, result]) =>
      result.kind === "invalid" ? { path: result.path, message: result.message } : undefined
    )
    .filter((entry): entry is { path: string; message: string } => Boolean(entry));
  if (invalid.length > 0) return { kind: "invalid", invalid };

  const stores = {} as Stores;
  for (const [key, result] of entries) {
    if (result.kind === "ok") stores[key] = result.value as never;
  }
  return { kind: "ok", stores };
}

async function readStore<T>(root: string, relativePath: string, schema: ZodTypeAny): Promise<ReadResult<T>> {
  let raw = "";
  try {
    raw = await readFile(join(root, relativePath), "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return { kind: "missing", path: relativePath };
    return { kind: "invalid", path: relativePath, message: error instanceof Error ? error.message : String(error) };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    return { kind: "invalid", path: relativePath, message: error instanceof Error ? error.message : String(error) };
  }
  const parsed = schema.safeParse(parsedJson);
  if (!parsed.success) return { kind: "invalid", path: relativePath, message: parsed.error.message };
  return { kind: "ok", value: parsed.data };
}

function interpretState(workspace: WorkspaceState): OperatorState {
  const selection = selectActive(workspace.intents, workspace.deployments);
  if (!selection.intent && !selection.deployment) {
    return baseState({
      workflow_state: "idle",
      readiness: { workspace_initialized: true, state_valid: true },
      recommended_next_command: "maw intent create --text \"Describe the work\"",
      recommended_next_reason: "no active intent exists."
    });
  }

  if (selection.deployment) {
    return interpretDeployment(workspace, selection.deployment, selection.intent);
  }

  if (selection.intent?.status === "new") {
    return baseState({
      workflow_state: "planning_needed",
      active_intent_id: selection.intent.intent_id,
      readiness: {
        workspace_initialized: true,
        state_valid: true,
        has_active_intent: true
      },
      recommended_next_command: "maw orchestrate --intent " + selection.intent.intent_id,
      recommended_next_reason: "active intent is new and has no deployment."
    });
  }

  return baseState({
    workflow_state: "idle",
    active_intent_id: selection.intent?.intent_id,
    readiness: {
      workspace_initialized: true,
      state_valid: true,
      has_active_intent: Boolean(selection.intent)
    },
    recommended_next_command: "maw intent create --text \"Describe the work\"",
    recommended_next_reason: "no active deployment exists."
  });
}

function interpretDeployment(
  workspace: WorkspaceState,
  deployment: DeploymentPlan,
  intent: Intent | undefined
): OperatorState {
  const tasks = tasksForDeployment(workspace.tasks, deployment);
  const taskIds = new Set(tasks.map((task) => task.task_id));
  const planCheck = latestPlanCheck(workspace.planChecks, deployment.deployment_id);
  const planCheckCurrent = Boolean(planCheck && !isOlder(planCheckTimestamp(planCheck), deployment.updated_at));
  const planCheckPassed = Boolean(planCheckCurrent && planCheck?.status === "pass");
  const approved = hasApproval(workspace.approvals, deployment);
  const score = latestScore(workspace.scores, deployment.deployment_id);
  const scoreCurrent = Boolean(score && !isOlder(scoreTimestamp(score), newestRelevantTimestamp(deployment, tasks, workspace.consensus.consensus_records)));
  const retrospectivePresent = workspace.retrospectives.retrospectives.some(
    (entry) => entry.deployment_id === deployment.deployment_id
  );
  const performanceCurrent = workspace.performance.entries.some(
    (entry) => entry.deployment_id === deployment.deployment_id
  );
  const verificationGap = firstVerificationGap(tasks, workspace.consensus.consensus_records);
  const failedTasks = sortedTasks(tasks.filter((task) => task.status === "failed"));
  const blockedTasks = sortedTasks(tasks.filter((task) => task.status === "blocked"));
  const runningTasks = tasks.filter((task) => task.status === "running");
  const actionRequiredMessages = workspace.chat.messages.filter(
    (message) => message.requires_action && (!message.task_id || taskIds.has(message.task_id))
  );
  const blockers = [
    ...failedTasks.map((task) =>
      condition("TASK_FAILED", "Task " + task.task_id + " failed" + blockerSuffix(task) + ".", task.task_id, "high")
    ),
    ...blockedTasks.map((task) =>
      condition("TASK_BLOCKED", "Task " + task.task_id + " is blocked" + blockerSuffix(task) + ".", task.task_id, "high")
    ),
    ...actionRequiredMessages.map((message) =>
      condition("CHAT_REQUIRES_ACTION", "Action required from chat " + message.message_id + ": " + message.summary, message.task_id ?? message.message_id, "high")
    )
  ];
  const stale = staleConditions({
    deployment,
    planCheck,
    planCheckCurrent,
    score,
    scoreCurrent,
    retrospectivePresent,
    performanceCurrent
  });
  const risky = riskyConditions({
    deployment,
    planCheck,
    planCheckCurrent,
    approved,
    verificationGap
  });
  const baseReadiness = {
    workspace_initialized: true,
    state_valid: true,
    has_active_intent: Boolean(intent),
    has_active_deployment: true,
    plan_check_current: planCheckCurrent,
    plan_check_passed: planCheckPassed,
    approval_present: approved,
    execution_ready: false,
    verification_complete: !verificationGap,
    score_current: scoreCurrent,
    retrospective_present: retrospectivePresent,
    performance_current: performanceCurrent
  };

  if (failedTasks.length > 0 || deployment.status === "failed") {
    return baseState({
      workflow_state: "failed",
      active_intent_id: intent?.intent_id ?? deployment.intent_id,
      active_deployment_id: deployment.deployment_id,
      active_task_id: failedTasks[0]?.task_id,
      blockers,
      readiness: baseReadiness,
      stale_conditions: stale,
      risky_conditions: risky,
      recommended_next_command: "maw doctor",
      recommended_next_reason: "active blockers or failed tasks require diagnosis before continuing."
    });
  }

  if (blockedTasks.length > 0 || deployment.status === "blocked" || actionRequiredMessages.length > 0) {
    return baseState({
      workflow_state: "blocked",
      active_intent_id: intent?.intent_id ?? deployment.intent_id,
      active_deployment_id: deployment.deployment_id,
      active_task_id: blockedTasks[0]?.task_id ?? actionRequiredMessages[0]?.task_id,
      blockers,
      readiness: baseReadiness,
      stale_conditions: stale,
      risky_conditions: risky,
      recommended_next_command: "maw doctor",
      recommended_next_reason: "active blockers or failed tasks require diagnosis before continuing."
    });
  }

  if (deployment.status === "running" || runningTasks.length > 0) {
    return baseState({
      workflow_state: "execution_in_progress",
      active_intent_id: intent?.intent_id ?? deployment.intent_id,
      active_deployment_id: deployment.deployment_id,
      active_task_id: sortedTasks(runningTasks)[0]?.task_id,
      readiness: baseReadiness,
      stale_conditions: stale,
      risky_conditions: risky,
      recommended_next_command: "maw status",
      recommended_next_reason: "deployment is marked running."
    });
  }

  if (deployment.status === "proposed") {
    if (!planCheckCurrent || !planCheckPassed) {
      return deploymentState("approval_precheck_needed", workspace, deployment, intent, baseReadiness, blockers, stale, risky, {
        command: "maw plan-check --deployment " + deployment.deployment_id,
        reason: "deployment is proposed and needs a current plan check before approval."
      });
    }
    return deploymentState("approval_needed", workspace, deployment, intent, baseReadiness, blockers, stale, risky, {
      command: approvalCommand(deployment.deployment_id),
      reason: "current plan check passes and deployment is not approved."
    });
  }

  if (deployment.status === "approved") {
    if (!approved) {
      return deploymentState("approval_needed", workspace, deployment, intent, baseReadiness, blockers, stale, risky, {
        command: approvalCommand(deployment.deployment_id),
        reason: "deployment requires approval before execution."
      });
    }
    return deploymentState(
      "execution_ready",
      workspace,
      deployment,
      intent,
      { ...baseReadiness, execution_ready: true },
      blockers,
      stale,
      risky,
      {
        command: runCommand(deployment),
        reason: "deployment is approved and ready to run."
      }
    );
  }

  if (verificationGap) {
    return deploymentState("verification_needed", workspace, deployment, intent, baseReadiness, blockers, stale, risky, {
      activeTaskId: verificationGap.task_id,
      command: verificationCommand(workspace.reviews, deployment.deployment_id, verificationGap.task_id),
      reason: "review-required output is not yet verified by passing load-bearing consensus."
    });
  }

  if (!scoreCurrent) {
    return deploymentState("scoring_needed", workspace, deployment, intent, baseReadiness, blockers, stale, risky, {
      command: "maw score --deployment " + deployment.deployment_id,
      reason: "deployment has run but no current workflow score exists."
    });
  }

  if (!retrospectivePresent) {
    return deploymentState("retrospective_needed", workspace, deployment, intent, baseReadiness, blockers, stale, risky, {
      command: "maw retrospective --deployment " + deployment.deployment_id,
      reason: "deployment has score state but no retrospective record."
    });
  }

  if (!performanceCurrent) {
    return deploymentState("performance_update_needed", workspace, deployment, intent, baseReadiness, blockers, stale, risky, {
      command: "maw performance update --deployment " + deployment.deployment_id,
      reason: "deployment lacks performance ledger entries."
    });
  }

  return deploymentState("complete", workspace, deployment, intent, baseReadiness, blockers, stale, risky, {
    command: "maw report",
    reason: "workflow evidence is ready for handoff."
  });
}

function deploymentState(
  workflowState: OperatorWorkflowState,
  workspace: WorkspaceState,
  deployment: DeploymentPlan,
  intent: Intent | undefined,
  readiness: Partial<OperatorReadiness>,
  blockers: OperatorCondition[],
  stale: OperatorCondition[],
  risky: OperatorCondition[],
  recommendation: { command: string; reason: string; activeTaskId?: string }
): OperatorState {
  return baseState({
    workflow_state: workflowState,
    active_intent_id: intent?.intent_id ?? deployment.intent_id,
    active_deployment_id: deployment.deployment_id,
    active_task_id: recommendation.activeTaskId,
    blockers,
    readiness,
    stale_conditions: stale,
    risky_conditions: risky,
    recommended_next_command: recommendation.command,
    recommended_next_reason: recommendation.reason
  });
}

function selectActive(
  intents: Intent[],
  deployments: DeploymentPlan[]
): { intent?: Intent; deployment?: DeploymentPlan } {
  const intentsById = new Map(intents.map((intent) => [intent.intent_id, intent]));
  const deploymentIntentIds = new Set(deployments.map((deployment) => deployment.intent_id));
  const preferredDeployment = newest(
    deployments.filter((deployment) => activeDeploymentStatuses.has(deployment.status)),
    (deployment) => deployment.created_at,
    (deployment) => deployment.deployment_id
  );
  if (preferredDeployment) {
    return {
      deployment: preferredDeployment,
      intent: intentsById.get(preferredDeployment.intent_id)
    };
  }

  const newIntent = newest(
    intents.filter((intent) => intent.status === "new" && !deploymentIntentIds.has(intent.intent_id)),
    (intent) => intent.created_at,
    (intent) => intent.intent_id
  );
  if (newIntent) return { intent: newIntent };

  const anyDeployment = newest(deployments, (deployment) => deployment.created_at, (deployment) => deployment.deployment_id);
  if (anyDeployment) {
    return {
      deployment: anyDeployment,
      intent: intentsById.get(anyDeployment.intent_id)
    };
  }

  return {
    intent: newest(intents, (intent) => intent.created_at, (intent) => intent.intent_id)
  };
}

function tasksForDeployment(tasks: Task[], deployment: DeploymentPlan): Task[] {
  const assignmentTaskIds = new Set(deployment.assignments.map((assignment) => assignment.task_id));
  return sortedTasks(
    tasks.filter((task) => task.deployment_id === deployment.deployment_id || assignmentTaskIds.has(task.task_id))
  );
}

function sortedTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((left, right) => compareIds(left.task_id, right.task_id));
}

function firstVerificationGap(tasks: Task[], consensusRecords: Consensus[]): Task | undefined {
  return sortedTasks(tasks).find((task) => {
    if (!task.review_required || task.status !== "completed") return false;
    return !consensusRecords.some(
      (record) =>
        record.task_id === task.task_id &&
        record.is_load_bearing &&
        record.overall_verdict === "pass"
    );
  });
}

function verificationCommand(reviews: ReviewLog, deploymentId: string, taskId: string): string {
  if (reviews.reviews.some((review) => review.task_id === taskId)) {
    return "maw consensus compute --task " + taskId;
  }
  return "maw run --deployment " + deploymentId + " --rerun";
}

function latestPlanCheck(store: PlanCheckStore, deploymentId: string): PlanCheck | undefined {
  return newest(
    store.plan_checks.filter((check) => check.deployment_id === deploymentId),
    planCheckTimestamp,
    (check) => check.check_id
  );
}

function latestScore(store: WorkflowScoreStore, deploymentId: string): WorkflowScore | undefined {
  return newest(
    store.workflow_scores.filter((score) => score.deployment_id === deploymentId),
    scoreTimestamp,
    (score) => score.score_id
  );
}

function hasApproval(store: ApprovalStore, deployment: DeploymentPlan): boolean {
  if (!deployment.approval_required) return true;
  return store.approvals.some(
    (approval) => approval.deployment_id === deployment.deployment_id && approval.decision === "approved"
  );
}

function staleConditions(input: {
  deployment: DeploymentPlan;
  planCheck: PlanCheck | undefined;
  planCheckCurrent: boolean;
  score: WorkflowScore | undefined;
  scoreCurrent: boolean;
  retrospectivePresent: boolean;
  performanceCurrent: boolean;
}): OperatorCondition[] {
  const conditions: OperatorCondition[] = [];
  if (input.deployment.status === "proposed" && !input.planCheck) {
    conditions.push(
      condition("PLAN_CHECK_MISSING", "Deployment " + input.deployment.deployment_id + " has no plan check.", input.deployment.deployment_id, "medium")
    );
  } else if (input.deployment.status === "proposed" && input.planCheck && !input.planCheckCurrent) {
    conditions.push(
      condition("PLAN_CHECK_STALE", "Plan check for " + input.deployment.deployment_id + " is older than the deployment.", input.deployment.deployment_id, "medium")
    );
  }
  if ((input.deployment.status === "completed" || input.deployment.status === "failed") && !input.score) {
    conditions.push(
      condition("SCORE_MISSING", "Deployment " + input.deployment.deployment_id + " has no workflow score.", input.deployment.deployment_id, "medium")
    );
  } else if (input.score && !input.scoreCurrent) {
    conditions.push(
      condition("SCORE_STALE", "Workflow score for " + input.deployment.deployment_id + " is older than relevant workflow state.", input.deployment.deployment_id, "medium")
    );
  }
  if (input.scoreCurrent && !input.retrospectivePresent) {
    conditions.push(
      condition("RETROSPECTIVE_MISSING", "Deployment " + input.deployment.deployment_id + " has score state but no retrospective.", input.deployment.deployment_id, "low")
    );
  }
  if (input.scoreCurrent && !input.performanceCurrent) {
    conditions.push(
      condition("PERFORMANCE_LEDGER_MISSING", "Deployment " + input.deployment.deployment_id + " has no performance ledger entries.", input.deployment.deployment_id, "low")
    );
  }
  return conditions;
}

function riskyConditions(input: {
  deployment: DeploymentPlan;
  planCheck: PlanCheck | undefined;
  planCheckCurrent: boolean;
  approved: boolean;
  verificationGap: Task | undefined;
}): OperatorCondition[] {
  const conditions: OperatorCondition[] = [];
  if (
    input.planCheckCurrent &&
    input.planCheck?.status === "fail" &&
    input.planCheck.issues.some((issue) => issue.severity === "high")
  ) {
    conditions.push(
      condition("PLAN_CHECK_HIGH_SEVERITY", "Current plan check has high-severity issues.", input.deployment.deployment_id, "high")
    );
  }
  if (input.deployment.approval_required && !input.approved) {
    conditions.push(
      condition("APPROVAL_MISSING", "Deployment " + input.deployment.deployment_id + " requires approval.", input.deployment.deployment_id, "medium")
    );
  }
  if (input.verificationGap) {
    conditions.push(
      condition("VERIFICATION_MISSING", "Task " + input.verificationGap.task_id + " lacks passing load-bearing consensus.", input.verificationGap.task_id, "medium")
    );
  }
  return conditions;
}

function newest<T>(
  values: T[],
  timestamp: (value: T) => string | undefined,
  id: (value: T) => string
): T | undefined {
  return [...values].sort((left, right) => {
    const timeDiff = timestampValue(timestamp(right)) - timestampValue(timestamp(left));
    if (timeDiff !== 0) return timeDiff;
    return compareIds(id(right), id(left));
  })[0];
}

function newestRelevantTimestamp(
  deployment: DeploymentPlan,
  tasks: Task[],
  consensusRecords: Consensus[]
): string {
  const taskIds = new Set(tasks.map((task) => task.task_id));
  const values = [
    deployment.updated_at,
    ...tasks.map((task) => task.updated_at),
    ...consensusRecords
      .filter((record) => taskIds.has(record.task_id))
      .map((record) => record.updated_at ?? record.created_at)
  ];
  return values.sort((left, right) => timestampValue(right) - timestampValue(left))[0] ?? deployment.updated_at;
}

function isOlder(left: string | undefined, right: string | undefined): boolean {
  return timestampValue(left) < timestampValue(right);
}

function planCheckTimestamp(check: PlanCheck): string {
  return check.updated_at ?? check.created_at;
}

function scoreTimestamp(score: WorkflowScore): string {
  return score.updated_at ?? score.created_at;
}

function timestampValue(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareIds(left: string, right: string): number {
  const leftNumber = trailingNumber(left);
  const rightNumber = trailingNumber(right);
  if (leftNumber !== undefined && rightNumber !== undefined && leftNumber !== rightNumber) {
    return leftNumber - rightNumber;
  }
  return left.localeCompare(right);
}

function trailingNumber(value: string): number | undefined {
  const match = /(\d+)$/.exec(value);
  return match?.[1] ? Number(match[1]) : undefined;
}

function runCommand(deployment: DeploymentPlan): string {
  const base = "maw run --deployment " + deployment.deployment_id;
  return deployment.assignments.some((assignment) => assignment.executor === "local_command")
    ? base + " --execute"
    : base;
}

function approvalCommand(deploymentId: string): string {
  return "maw approval record --deployment " + deploymentId + " --approver \"operator\" --scope \"Run " + deploymentId + " after plan-check review.\"";
}

function blockerSuffix(task: Task): string {
  return task.blocker ? ": " + task.blocker : "";
}

function condition(
  code: string,
  message: string,
  target: string | undefined,
  severity: OperatorCondition["severity"]
): OperatorCondition {
  return target ? { code, message, target, severity } : { code, message, severity };
}

function baseState(input: {
  workflow_state: OperatorWorkflowState;
  active_intent_id?: string;
  active_deployment_id?: string;
  active_task_id?: string;
  blockers?: OperatorCondition[];
  readiness?: Partial<OperatorReadiness>;
  stale_conditions?: OperatorCondition[];
  risky_conditions?: OperatorCondition[];
  recommended_next_command: string;
  recommended_next_reason: string;
}): OperatorState {
  const baseReadiness: OperatorReadiness = {
    workspace_initialized: false,
    state_valid: false,
    has_active_intent: false,
    has_active_deployment: false,
    plan_check_current: false,
    plan_check_passed: false,
    approval_present: false,
    execution_ready: false,
    verification_complete: false,
    score_current: false,
    retrospective_present: false,
    performance_current: false,
    ...input.readiness
  };
  return {
    workflow_state: input.workflow_state,
    active_intent_id: input.active_intent_id,
    active_deployment_id: input.active_deployment_id,
    active_task_id: input.active_task_id,
    blockers: input.blockers ?? [],
    readiness: baseReadiness,
    stale_conditions: input.stale_conditions ?? [],
    risky_conditions: input.risky_conditions ?? [],
    recommended_next_command: input.recommended_next_command,
    recommended_next_reason: input.recommended_next_reason
  };
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
  );
}
