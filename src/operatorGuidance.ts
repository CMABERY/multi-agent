import { readOperatorState, type OperatorState } from "./operatorState.js";

export function renderTransitionGuidance(state: OperatorState): string {
  return [
    "Workflow State: " + state.workflow_state,
    "Next: " + state.recommended_next_command,
    "Reason: " + state.recommended_next_reason
  ].join("\n");
}

export async function renderCurrentTransitionGuidance(root: string): Promise<string> {
  return renderTransitionGuidance(await readOperatorState(root));
}
