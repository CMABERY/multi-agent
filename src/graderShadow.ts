// Shadow-mode and enforcement-readiness state machine for the Grader subsystem.
//
// Pure functions only. NO IO. Does NOT import from any other src/ module so the
// unit can land independently of the surrounding Wave 1 work.
//
// Implements the trajectory and gates from docs/grader-architecture.md:
//   - Section 4.4 (three-meaning shadow disambiguation) for the default shadow
//     trajectory: calibrating -> observation_shadow -> action_reversal_shadow
//     -> enforcement_pending -> enforced.
//   - Section 7 (enforcement-readiness contract) for the seven-step gate that
//     must pass before a grader exits provisional state.
//
// The EnforcementState alias below mirrors EnforcementStateSchema in
// src/schemas.ts (added by a sibling Wave 1 unit). Keep the union in sync if
// the schema evolves.
export type EnforcementState =
  | "calibrating"
  | "observation_shadow"
  | "action_reversal_shadow"
  | "enforcement_pending"
  | "enforced";

export interface EnforcementSignals {
  observationDays: number;
  actionReversalDays: number;
  calibrationLocked: boolean;
  powerCheckPassed: boolean;
  goodhartAuditPassed: boolean;
  reconciliationTested: boolean;
  citationsAudited: boolean;
  abortConditionMet: boolean;
}

export interface EnforcementTransition {
  next: EnforcementState;
  reason: string;
}

const OBSERVATION_DAYS_REQUIRED = 30;
const ACTION_REVERSAL_DAYS_REQUIRED = 60;

// Compute the next enforcement state from the current state plus the latest
// operational signals. Pure function: same inputs always produce the same
// outputs and no external state is read or written.
export function nextEnforcementState(
  current: EnforcementState,
  signals: EnforcementSignals,
): EnforcementTransition {
  switch (current) {
    case "calibrating":
      if (signals.calibrationLocked) {
        return { next: "observation_shadow", reason: "calibration_locked" };
      }
      return { next: "calibrating", reason: "awaiting_calibration_lock" };

    case "observation_shadow":
      if (!signals.powerCheckPassed) {
        return {
          next: "observation_shadow",
          reason: "calibration_underpowered",
        };
      }
      if (signals.observationDays < OBSERVATION_DAYS_REQUIRED) {
        return {
          next: "observation_shadow",
          reason: "observation_window_incomplete",
        };
      }
      return {
        next: "action_reversal_shadow",
        reason: "observation_shadow_complete",
      };

    case "action_reversal_shadow":
      if (signals.abortConditionMet) {
        return {
          next: "observation_shadow",
          reason: "abort_condition_rolled_back_to_observation",
        };
      }
      if (signals.actionReversalDays < ACTION_REVERSAL_DAYS_REQUIRED) {
        return {
          next: "action_reversal_shadow",
          reason: "action_reversal_window_incomplete",
        };
      }
      return {
        next: "enforcement_pending",
        reason: "action_reversal_shadow_complete",
      };

    case "enforcement_pending": {
      const failingGate = firstFailingEnforcementGate(signals);
      if (failingGate !== null) {
        return { next: "enforcement_pending", reason: failingGate };
      }
      return {
        next: "enforced",
        reason: "enforcement_readiness_contract_satisfied",
      };
    }

    case "enforced":
      if (signals.abortConditionMet) {
        return {
          next: "action_reversal_shadow",
          reason: "abort_from_enforced",
        };
      }
      return { next: "enforced", reason: "enforced_steady_state" };

    default: {
      // Exhaustiveness guard. If a new state is added to the union, the
      // compiler flags this branch.
      const exhaustive: never = current;
      return exhaustive;
    }
  }
}

// Decide the decision-flip mode that downstream code should apply for a given
// enforcement state. This encodes Section 4.4 in a single place so callers
// never have to interpret state strings inline.
export function decisionFlipMode(state: EnforcementState): "off" | "advisory" | "active" {
  switch (state) {
    case "calibrating":
      return "off";
    case "observation_shadow":
      return "off";
    case "action_reversal_shadow":
      return "advisory";
    case "enforcement_pending":
      return "off";
    case "enforced":
      return "active";
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

// Return the name of the first failing gate from the section-7 enforcement
// readiness contract, or null when every gate passes. Order is fixed so
// reasons are deterministic across runs and easy to assert against in tests.
function firstFailingEnforcementGate(signals: EnforcementSignals): string | null {
  if (!signals.calibrationLocked) {
    return "gate_failed_calibration_locked";
  }
  if (!signals.citationsAudited) {
    return "gate_failed_citations_audited";
  }
  if (!signals.powerCheckPassed) {
    return "gate_failed_power_check_passed";
  }
  if (signals.observationDays < OBSERVATION_DAYS_REQUIRED) {
    return "gate_failed_observation_days";
  }
  if (signals.actionReversalDays < ACTION_REVERSAL_DAYS_REQUIRED) {
    return "gate_failed_action_reversal_days";
  }
  if (!signals.reconciliationTested) {
    return "gate_failed_reconciliation_tested";
  }
  if (!signals.goodhartAuditPassed) {
    return "gate_failed_goodhart_audit_passed";
  }
  return null;
}
