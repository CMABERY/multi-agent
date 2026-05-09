import type { Command } from "commander";
import { createCli } from "./cli.js";
import {
  classifyOperatorCommand,
  deriveCommandFamily,
  recordOperatorEvent,
  type OperatorEventInput
} from "./operatorExperience.js";
import { buildRecoveryPacket, renderRecoveryPacket } from "./operatorRecovery.js";
import { readOperatorState } from "./operatorState.js";

function applyExitOverride(command: Command): void {
  command.exitOverride();
  for (const sub of command.commands) {
    applyExitOverride(sub);
  }
}

export async function runOperatorCli(argv: string[], root: string = process.cwd()): Promise<void> {
  process.exitCode = undefined;
  const program = createCli(root);
  applyExitOverride(program);

  const classification = classifyOperatorCommand(argv);

  let outcome: OperatorEventInput["outcome"] = "success";
  let recoverableError = false;
  let recoveryHints: OperatorEventInput["recoveryHints"] = undefined;

  try {
    await program.parseAsync(argv);
  } catch (error: unknown) {
    const code = errorCode(error);
    if (
      code === "commander.helpDisplayed" ||
      code === "commander.help" ||
      code === "commander.version"
    ) {
      outcome = "help";
    } else if (typeof code === "string" && code.startsWith("commander.")) {
      outcome = "invalid";
      process.exitCode = 1;
    } else {
      outcome = "failure";
      const packet = await buildRecoveryPacket(root, error);
      if (packet) {
        console.error(renderRecoveryPacket(packet));
        recoverableError = true;
        recoveryHints = {
          correctiveFamily: deriveCommandFamily(packet.corrective_command),
          nextFamily: deriveCommandFamily(packet.next_command)
        };
      } else {
        console.error(error instanceof Error ? error.message : String(error));
      }
      process.exitCode = 1;
    }
  }

  if (outcome === "success" && process.exitCode !== undefined && process.exitCode !== 0) {
    outcome = "failure";
  }

  let workflowStateAfter: string | undefined = undefined;
  let workspaceReady = false;
  try {
    const state = await readOperatorState(root);
    workflowStateAfter = state.workflow_state;
    workspaceReady =
      state.workflow_state !== "uninitialized" && state.workflow_state !== "state_invalid";
  } catch {
    workspaceReady = false;
  }

  if (!classification.skipRecording && workspaceReady) {
    const isInvalid = outcome === "invalid";
    const nextStepApplicable = isInvalid ? false : classification.nextStepApplicable;
    const nextStepPresent = isInvalid
      ? false
      : (outcome === "success" && classification.nextStepApplicable) ||
        (outcome === "failure" && recoverableError && classification.nextStepApplicable);
    try {
      await recordOperatorEvent(root, {
        command: classification.family,
        outcome,
        nextStepApplicable,
        nextStepPresent,
        recoverableError,
        recoveryHints,
        extensionCommand: classification.isExtension,
        workflowStateAfter
      });
    } catch {
      // Metrics recording is best-effort; never propagate to the operator.
    }
  }
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const value = (error as { code?: unknown }).code;
    if (typeof value === "string") return value;
  }
  return "";
}
