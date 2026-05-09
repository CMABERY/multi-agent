import {
  OperatorExperienceSchema,
  type OperatorEvent,
  type OperatorEventOutcome,
  type OperatorExperience
} from "./schemas.js";
import { loadJsonOrDefault, nowIso, saveJson } from "./storage.js";

const STATE_PATH = "state/operator_experience.json";
const EVENT_LOG_CAP = 500;

const POST_EXECUTION_STATES = new Set([
  "verification_needed",
  "scoring_needed",
  "retrospective_needed",
  "performance_update_needed",
  "complete"
]);

const GROUP_VERBS = new Set([
  "intent",
  "approval",
  "review",
  "consensus",
  "performance",
  "scaffold",
  "operator"
]);

const KNOWN_TOP_LEVEL_COMMANDS = new Set([
  "init",
  "status",
  "next",
  "doctor",
  "intent",
  "orchestrate",
  "plan-check",
  "approval",
  "run",
  "validate",
  "score",
  "retrospective",
  "performance",
  "report",
  "bootstrap",
  "scaffold",
  "operator",
  "review",
  "consensus",
  "migrate",
  "context-check",
  "help"
]);

const KNOWN_GROUP_SUBCOMMANDS: Record<string, Set<string>> = {
  intent: new Set(["create"]),
  approval: new Set(["record"]),
  review: new Set(["record"]),
  consensus: new Set(["compute"]),
  performance: new Set(["update"]),
  scaffold: new Set(["agent", "reviewer", "protocol", "command"]),
  operator: new Set(["metrics"])
};

const NO_NEXT_STEP_FAMILIES = new Set(["report", "operator metrics"]);

export interface OperatorEventInput {
  command: string;
  outcome: OperatorEventOutcome;
  nextStepApplicable: boolean;
  nextStepPresent: boolean;
  recoverableError: boolean;
  recoveryHints?: { correctiveFamily?: string; nextFamily?: string };
  extensionCommand: boolean;
  workflowStateAfter?: string;
}

export interface OperatorCommandClassification {
  family: string;
  nextStepApplicable: boolean;
  isExtension: boolean;
  isMetrics: boolean;
  skipRecording: boolean;
  isJsonOutput: boolean;
  isHelpRequested: boolean;
}

export interface OperatorExperienceMetrics {
  command_attempts: number;
  next_step_applicable: number;
  next_step_present: number;
  invalid_count: number;
  help_count: number;
  recoverable_error_count: number;
  recovery_success_count: number;
  extension_total: number;
  extension_success: number;
  time_to_first_successful_workflow_ms: number | undefined;
  commands_before_successful_deployment: number | undefined;
  started_at: string;
  first_successful_deployment_at: string | null;
  first_complete_workflow_at: string | null;
}

export function defaultOperatorExperience(now: string): OperatorExperience {
  return {
    started_at: now,
    updated_at: now,
    events: [],
    pending_recovery: null,
    first_successful_deployment_at: null,
    first_complete_workflow_at: null
  };
}

export async function readOperatorExperience(root: string): Promise<OperatorExperience> {
  const raw = await loadJsonOrDefault<unknown>(root, STATE_PATH, null);
  if (raw === null || raw === undefined) return defaultOperatorExperience(nowIso());
  const parsed = OperatorExperienceSchema.safeParse(raw);
  if (!parsed.success) return defaultOperatorExperience(nowIso());
  return parsed.data;
}

export async function recordOperatorEvent(root: string, input: OperatorEventInput): Promise<void> {
  let experience: OperatorExperience;
  try {
    experience = await readOperatorExperience(root);
  } catch {
    return;
  }

  const now = nowIso();
  const eventId =
    "OX-" + String(experience.events.length + 1).padStart(3, "0");

  let recoverySuccess = false;
  if (
    input.outcome === "success" &&
    experience.pending_recovery &&
    (experience.pending_recovery.corrective_family === input.command ||
      experience.pending_recovery.next_family === input.command)
  ) {
    recoverySuccess = true;
  }

  const event: OperatorEvent = {
    event_id: eventId,
    created_at: now,
    command: input.command,
    outcome: input.outcome,
    next_step_applicable: input.nextStepApplicable,
    next_step_present: input.nextStepPresent,
    recoverable_error: input.recoverableError,
    recovery_success: recoverySuccess,
    extension_command: input.extensionCommand,
    ...(input.workflowStateAfter ? { workflow_state_after: input.workflowStateAfter } : {})
  };

  experience.events.push(event);
  if (experience.events.length > EVENT_LOG_CAP) {
    experience.events = experience.events.slice(-EVENT_LOG_CAP);
  }
  experience.updated_at = now;

  if (recoverySuccess) {
    experience.pending_recovery = null;
  } else if (input.recoverableError) {
    experience.pending_recovery = {
      corrective_family: input.recoveryHints?.correctiveFamily,
      next_family: input.recoveryHints?.nextFamily,
      recorded_at: now
    };
  }

  if (
    !experience.first_successful_deployment_at &&
    input.outcome === "success" &&
    input.command === "run" &&
    isPostExecutionState(input.workflowStateAfter)
  ) {
    experience.first_successful_deployment_at = now;
  }

  if (!experience.first_complete_workflow_at && input.workflowStateAfter === "complete") {
    experience.first_complete_workflow_at = now;
  }

  try {
    await saveJson(root, STATE_PATH, experience);
  } catch {
    return;
  }
}

export function deriveOperatorMetrics(experience: OperatorExperience): OperatorExperienceMetrics {
  const events = experience.events;
  const commandAttempts = events.length;
  const helpCount = events.filter((event) => event.outcome === "help").length;
  const invalidCount = events.filter((event) => event.outcome === "invalid").length;
  const nextApplicable = events.filter((event) => event.next_step_applicable).length;
  const nextPresent = events.filter((event) => event.next_step_present).length;
  const recoverable = events.filter((event) => event.recoverable_error).length;
  const recoverySuccess = events.filter((event) => event.recovery_success).length;
  const extensionEvents = events.filter((event) => event.extension_command);
  const extensionSuccess = extensionEvents.filter((event) => event.outcome === "success").length;

  const startedAtMs = Date.parse(experience.started_at);
  const firstComplete = experience.first_complete_workflow_at;
  const timeToFirstWorkflow =
    firstComplete && Number.isFinite(startedAtMs)
      ? Math.max(0, Date.parse(firstComplete) - startedAtMs)
      : undefined;

  let commandsBeforeDeployment: number | undefined = undefined;
  if (experience.first_successful_deployment_at) {
    const target = experience.first_successful_deployment_at;
    let count = 0;
    for (const event of events) {
      if (event.created_at >= target) break;
      count += 1;
    }
    commandsBeforeDeployment = count;
  }

  return {
    command_attempts: commandAttempts,
    next_step_applicable: nextApplicable,
    next_step_present: nextPresent,
    invalid_count: invalidCount,
    help_count: helpCount,
    recoverable_error_count: recoverable,
    recovery_success_count: recoverySuccess,
    extension_total: extensionEvents.length,
    extension_success: extensionSuccess,
    time_to_first_successful_workflow_ms: timeToFirstWorkflow,
    commands_before_successful_deployment: commandsBeforeDeployment,
    started_at: experience.started_at,
    first_successful_deployment_at: experience.first_successful_deployment_at,
    first_complete_workflow_at: experience.first_complete_workflow_at
  };
}

export function renderOperatorExperienceReport(metrics: OperatorExperienceMetrics): string {
  return [
    "Operator Experience Metrics",
    "Command Attempts: " + metrics.command_attempts,
    "Next-Step Coverage: " + formatRatio(metrics.next_step_present, metrics.next_step_applicable),
    "Invalid Command Rate: " + formatRatio(metrics.invalid_count, metrics.command_attempts),
    "Help Invocation Rate: " + formatRatio(metrics.help_count, metrics.command_attempts),
    "Successful Error Recovery Rate: " +
      formatRatio(metrics.recovery_success_count, metrics.recoverable_error_count),
    "Extension Success Rate: " + formatRatio(metrics.extension_success, metrics.extension_total),
    "Time To First Successful Workflow: " +
      (metrics.time_to_first_successful_workflow_ms !== undefined
        ? formatDuration(metrics.time_to_first_successful_workflow_ms)
        : "n/a"),
    "Commands Before Successful Deployment: " +
      (metrics.commands_before_successful_deployment !== undefined
        ? String(metrics.commands_before_successful_deployment)
        : "n/a")
  ].join("\n");
}

export function classifyOperatorCommand(argv: string[]): OperatorCommandClassification {
  const args = stripExecutableArgs(argv);
  const tokens: string[] = [];
  let isJsonOutput = false;
  let isHelpRequested = false;
  for (const arg of args) {
    if (arg === "--help" || arg === "-h") {
      isHelpRequested = true;
      continue;
    }
    if (arg === "--version" || arg === "-V") {
      isHelpRequested = true;
      continue;
    }
    if (arg === "--json") {
      isJsonOutput = true;
      continue;
    }
    if (arg.startsWith("-")) continue;
    if (tokens.length < 2 || (tokens.length === 1 && GROUP_VERBS.has(tokens[0]!))) {
      tokens.push(arg);
    }
  }

  let family: string;
  if (tokens.length === 0) {
    family = isHelpRequested ? "help" : "unknown";
  } else if (!KNOWN_TOP_LEVEL_COMMANDS.has(tokens[0]!)) {
    family = "unknown";
  } else if (tokens.length >= 2 && GROUP_VERBS.has(tokens[0]!)) {
    const subs = KNOWN_GROUP_SUBCOMMANDS[tokens[0]!];
    family = subs && subs.has(tokens[1]!) ? tokens[0] + " " + tokens[1] : "unknown";
  } else {
    family = tokens[0]!;
  }

  const isExtension = family.startsWith("scaffold ");
  const isMetrics = family === "operator metrics";
  const inNoNextStep = NO_NEXT_STEP_FAMILIES.has(family);
  const nextStepApplicable = !isJsonOutput && !isHelpRequested && !inNoNextStep && family !== "help" && family !== "unknown";

  return {
    family,
    nextStepApplicable,
    isExtension,
    isMetrics,
    skipRecording: isMetrics,
    isJsonOutput,
    isHelpRequested
  };
}

export function deriveCommandFamily(command: string | undefined): string | undefined {
  if (!command) return undefined;
  const trimmed = command.replace(/^maw\s+/, "").trim();
  if (!trimmed) return undefined;
  const tokens: string[] = [];
  for (const part of trimmed.split(/\s+/)) {
    if (part.startsWith("-") || part.startsWith("$") || part.startsWith('"')) break;
    tokens.push(part);
  }
  if (tokens.length === 0) return undefined;
  if (tokens.length >= 2 && GROUP_VERBS.has(tokens[0]!)) {
    return tokens[0] + " " + tokens[1];
  }
  return tokens[0];
}

function isPostExecutionState(state: string | undefined): boolean {
  if (!state) return false;
  return POST_EXECUTION_STATES.has(state);
}

function stripExecutableArgs(argv: string[]): string[] {
  if (argv.length >= 2) return argv.slice(2);
  return argv;
}

function formatRatio(numerator: number, denominator: number): string {
  if (denominator === 0) return "0/0 (n/a)";
  const rate = numerator / denominator;
  return numerator + "/" + denominator + " (" + rate.toFixed(3) + ")";
}

function formatDuration(ms: number): string {
  if (ms < 0) return "0s";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return seconds + "s";
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return minutes + "m" + remainder + "s";
  const hours = Math.floor(minutes / 60);
  const minRemainder = minutes % 60;
  return hours + "h" + minRemainder + "m" + remainder + "s";
}
