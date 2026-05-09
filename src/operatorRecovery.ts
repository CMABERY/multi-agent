import { readOperatorState, type OperatorState } from "./operatorState.js";

export interface RecoveryPacket {
  recoverable: boolean;
  error_summary: string;
  why: string;
  state_safety: string;
  corrective_command: string;
  next_command: string;
}

export async function buildRecoveryPacket(root: string, error: unknown): Promise<RecoveryPacket | undefined> {
  const message = errorMessage(error);
  const state = await readState(root);

  let match = /^Deployment not found: (DP-\d{3,})$/.exec(message);
  if (match) {
    return packet(
      message,
      "the requested deployment ID is not present in state/deployment_plan.json.",
      "safe; no deployment command was run.",
      "maw status",
      "maw next"
    );
  }

  match = /^Intent not found: (I-\d{3,})$/.exec(message);
  if (match) {
    return packet(
      message,
      "the requested intent ID is not present in state/intent_queue.json.",
      "safe; no planning command was run.",
      "maw status",
      "maw intent create --text \"Describe the work\""
    );
  }

  match = /^Task not found: (T-\d{3,})$/.exec(message);
  if (match) {
    return packet(
      message,
      "the requested task ID is not present in state/task_board.json.",
      "safe; no task command was run.",
      "maw status",
      "maw next"
    );
  }

  match =
    /^Agent not found: (.+)$/.exec(message) ??
    /^Orchestrator selected unknown agent: (.+)$/.exec(message) ??
    /^Deployment assignment references unknown agent: (.+)$/.exec(message);
  if (match) {
    return packet(
      message,
      "the agent is not registered in state/agent_registry.json.",
      "safe; no agent-backed command was completed.",
      "maw doctor",
      "maw status"
    );
  }

  match = /^Deployment (DP-\d{3,}) requires explicit approval before execution\.$/.exec(message);
  if (match?.[1]) {
    const deploymentId = match[1];
    return packet(
      message,
      deploymentId + " requires approval and no approved approval record exists.",
      "safe; execution did not start.",
      "maw plan-check --deployment " + deploymentId,
      approvalCommand(deploymentId)
    );
  }

  match = /^Deployment (DP-\d{3,}) is not approved\. Current status: .+$/.exec(message);
  if (match?.[1]) {
    const deploymentId = match[1];
    return packet(
      message,
      "deployment status is not approved.",
      "safe; execution did not start.",
      "maw plan-check --deployment " + deploymentId,
      approvalCommand(deploymentId)
    );
  }

  match = /^Deployment (DP-\d{3,}) is already running\.$/.exec(message);
  if (match) {
    return packet(
      message,
      "a rerun was requested while the deployment is marked running.",
      "caution; do not start a second run until current state is inspected.",
      "maw status",
      "maw doctor"
    );
  }

  match = /^Local command task (T-\d{3,}) requires --execute\.$/.exec(message);
  if (match) {
    return packet(
      message,
      "local command execution is gated by an explicit operator flag.",
      "safe; local command did not run.",
      state?.active_deployment_id ? "maw run --deployment " + state.active_deployment_id + " --execute" : "maw status",
      "maw status"
    );
  }

  match = /^Local command task (T-\d{3,}) does not define a command\.$/.exec(message);
  if (match) {
    return packet(
      message,
      "the task is routed to local_command but has no command field.",
      "safe; local command did not run.",
      "maw doctor",
      state?.active_deployment_id ? "maw plan-check --deployment " + state.active_deployment_id : "maw status"
    );
  }

  match = /^Command is not allowlisted for ([^:]+): (.+)$/.exec(message);
  if (match) {
    return packet(
      message,
      "the assigned agent command_allowlist does not include the command.",
      "safe; local command did not run.",
      "maw doctor",
      state?.active_deployment_id ? "maw plan-check --deployment " + state.active_deployment_id : "maw status"
    );
  }

  match = /^Missing OpenAI API key environment variable: (.+)$/.exec(message);
  if (match?.[1]) {
    const envVar = match[1];
    return packet(
      message,
      "model-backed commands require the configured environment variable.",
      "safe; the model request did not run.",
      "$env:" + envVar + " = \"sk-...\"",
      "maw next"
    );
  }

  match = /^OpenAI Responses API request failed \((\d+)\): .+$/.exec(message);
  if (match) {
    return packet(
      message,
      "the model provider rejected the request.",
      "state may contain any records written before the provider failure; inspect status before rerun.",
      "maw status",
      "maw doctor"
    );
  }

  match = /^Model response truncated at max_output_tokens \(.+\)\.$/.exec(message);
  if (match) {
    return packet(
      message,
      "the model response hit the configured max_output_tokens limit.",
      "state may contain any records written before truncation; inspect status before rerun.",
      "maw doctor",
      "maw status"
    );
  }

  match = /^No structured reviews found for (T-\d{3,})\.$/.exec(message);
  if (match?.[1]) {
    const taskId = match[1];
    return packet(
      message,
      "consensus requires review records for the task.",
      "safe; consensus was not computed.",
      state?.active_deployment_id ? "maw run --deployment " + state.active_deployment_id + " --rerun" : "maw status",
      "maw consensus compute --task " + taskId
    );
  }

  match = /^Context path escapes workspace: (.+)$/.exec(message);
  if (match) {
    return packet(
      message,
      "MAW refuses context paths outside the workspace.",
      "safe; unsafe path was not read.",
      "maw doctor",
      state?.active_task_id ? "maw context-check --task " + state.active_task_id : "maw status"
    );
  }

  match = /^Intent (I-\d{3,}) is already \w+ and cannot be re-orchestrated\.( Existing deployments: .+)?$/.exec(
    message
  );
  if (match?.[1]) {
    const intentId = match[1];
    return packet(
      message,
      intentId + " is no longer in status new, so re-orchestration would create a duplicate deployment.",
      "safe; no orchestration was run.",
      "maw status",
      "maw intent create --text \"Describe the work\""
    );
  }

  match = /^No active deployment\. /.exec(message);
  if (match) {
    return packet(
      message,
      "the workspace has no active deployment to default to.",
      "safe; no command was run.",
      "maw status",
      "maw next"
    );
  }

  match = /^No active intent\. /.exec(message);
  if (match) {
    return packet(
      message,
      "the workspace has no active intent to default to.",
      "safe; no command was run.",
      "maw status",
      "maw intent create --text \"Describe the work\""
    );
  }

  match = /^No active task\. /.exec(message);
  if (match) {
    return packet(
      message,
      "the workspace has no active task to default to.",
      "safe; no command was run.",
      "maw status",
      "maw next"
    );
  }

  match = /^Orchestrator could not produce a valid plan after \d+ retries\. Final violations: .+$/.exec(message);
  if (match) {
    return packet(
      message,
      "generated plans failed deterministic pre-flight checks.",
      "safe; invalid plan was not persisted.",
      "maw doctor",
      state?.active_intent_id ? "maw orchestrate --intent " + state.active_intent_id : "maw status"
    );
  }

  return undefined;
}

export function renderRecoveryPacket(packet: RecoveryPacket): string {
  return [
    "Error: " + packet.error_summary,
    "Why: " + packet.why,
    "State Safety: " + packet.state_safety,
    "Corrective Command: " + packet.corrective_command,
    "Then: " + packet.next_command
  ].join("\n");
}

export async function handleCliError(root: string, error: unknown): Promise<void> {
  const packet = await buildRecoveryPacket(root, error);
  console.error(packet ? renderRecoveryPacket(packet) : errorMessage(error));
  process.exitCode = 1;
}

function packet(
  errorSummary: string,
  why: string,
  stateSafety: string,
  correctiveCommand: string,
  nextCommand: string
): RecoveryPacket {
  return {
    recoverable: true,
    error_summary: errorSummary,
    why,
    state_safety: stateSafety,
    corrective_command: correctiveCommand,
    next_command: nextCommand
  };
}

async function readState(root: string): Promise<OperatorState | undefined> {
  try {
    return await readOperatorState(root);
  } catch {
    return undefined;
  }
}

function approvalCommand(deploymentId: string): string {
  return "maw approval record --deployment " + deploymentId + " --approver \"operator\" --scope \"Run " + deploymentId + " after plan-check review.\"";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
