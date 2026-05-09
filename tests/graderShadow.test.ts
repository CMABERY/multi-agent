import { describe, expect, test } from "vitest";

import {
  decisionFlipMode,
  nextEnforcementState,
  type EnforcementSignals,
  type EnforcementState,
} from "../src/graderShadow.js";

function passingSignals(overrides: Partial<EnforcementSignals> = {}): EnforcementSignals {
  return {
    observationDays: 30,
    actionReversalDays: 60,
    calibrationLocked: true,
    powerCheckPassed: true,
    goodhartAuditPassed: true,
    reconciliationTested: true,
    citationsAudited: true,
    abortConditionMet: false,
    ...overrides,
  };
}

describe("nextEnforcementState - calibrating", () => {
  test("stays in calibrating until calibration locks", () => {
    const result = nextEnforcementState(
      "calibrating",
      passingSignals({ calibrationLocked: false }),
    );
    expect(result.next).toBe("calibrating");
    expect(result.reason).toBe("awaiting_calibration_lock");
  });

  test("advances to observation_shadow once calibration is locked", () => {
    const result = nextEnforcementState("calibrating", passingSignals({ calibrationLocked: true }));
    expect(result.next).toBe("observation_shadow");
  });
});

describe("nextEnforcementState - observation_shadow", () => {
  test("stays when calibration is underpowered (powerCheckPassed false)", () => {
    const result = nextEnforcementState(
      "observation_shadow",
      passingSignals({ observationDays: 45, powerCheckPassed: false }),
    );
    expect(result.next).toBe("observation_shadow");
    expect(result.reason).toBe("calibration_underpowered");
  });

  test("stays when fewer than 30 observation days have elapsed", () => {
    const result = nextEnforcementState(
      "observation_shadow",
      passingSignals({ observationDays: 29, powerCheckPassed: true }),
    );
    expect(result.next).toBe("observation_shadow");
    expect(result.reason).toBe("observation_window_incomplete");
  });

  test("advances to action_reversal_shadow at 30 days when power check passes", () => {
    const result = nextEnforcementState(
      "observation_shadow",
      passingSignals({ observationDays: 30, powerCheckPassed: true }),
    );
    expect(result.next).toBe("action_reversal_shadow");
  });
});

describe("nextEnforcementState - action_reversal_shadow", () => {
  test("regresses to observation_shadow when abort condition fires", () => {
    const result = nextEnforcementState(
      "action_reversal_shadow",
      passingSignals({ actionReversalDays: 75, abortConditionMet: true }),
    );
    expect(result.next).toBe("observation_shadow");
    expect(result.reason).toBe("abort_condition_rolled_back_to_observation");
  });

  test("stays when fewer than 60 action-reversal days have elapsed", () => {
    const result = nextEnforcementState(
      "action_reversal_shadow",
      passingSignals({ actionReversalDays: 59 }),
    );
    expect(result.next).toBe("action_reversal_shadow");
    expect(result.reason).toBe("action_reversal_window_incomplete");
  });

  test("advances to enforcement_pending after 60 days without abort", () => {
    const result = nextEnforcementState(
      "action_reversal_shadow",
      passingSignals({ actionReversalDays: 60, abortConditionMet: false }),
    );
    expect(result.next).toBe("enforcement_pending");
  });
});

describe("nextEnforcementState - enforcement_pending seven-step gate", () => {
  test("advances to enforced when every gate passes", () => {
    const result = nextEnforcementState("enforcement_pending", passingSignals());
    expect(result.next).toBe("enforced");
    expect(result.reason).toBe("enforcement_readiness_contract_satisfied");
  });

  test("stays and names calibrationLocked when calibration is not locked", () => {
    const result = nextEnforcementState(
      "enforcement_pending",
      passingSignals({ calibrationLocked: false }),
    );
    expect(result.next).toBe("enforcement_pending");
    expect(result.reason).toContain("calibration_locked");
  });

  test("stays and names citationsAudited when citations are not audited", () => {
    const result = nextEnforcementState(
      "enforcement_pending",
      passingSignals({ citationsAudited: false }),
    );
    expect(result.next).toBe("enforcement_pending");
    expect(result.reason).toContain("citations_audited");
  });

  test("stays and names powerCheckPassed when power check fails", () => {
    const result = nextEnforcementState(
      "enforcement_pending",
      passingSignals({ powerCheckPassed: false }),
    );
    expect(result.next).toBe("enforcement_pending");
    expect(result.reason).toContain("power_check_passed");
  });

  test("stays and names observationDays when observation window is short", () => {
    const result = nextEnforcementState(
      "enforcement_pending",
      passingSignals({ observationDays: 10 }),
    );
    expect(result.next).toBe("enforcement_pending");
    expect(result.reason).toContain("observation_days");
  });

  test("stays and names actionReversalDays when action-reversal window is short", () => {
    const result = nextEnforcementState(
      "enforcement_pending",
      passingSignals({ actionReversalDays: 30 }),
    );
    expect(result.next).toBe("enforcement_pending");
    expect(result.reason).toContain("action_reversal_days");
  });

  test("stays and names reconciliationTested when reconciliation has not been tested", () => {
    const result = nextEnforcementState(
      "enforcement_pending",
      passingSignals({ reconciliationTested: false }),
    );
    expect(result.next).toBe("enforcement_pending");
    expect(result.reason).toContain("reconciliation_tested");
  });

  test("stays and names goodhartAuditPassed when goodhart audit fails", () => {
    const result = nextEnforcementState(
      "enforcement_pending",
      passingSignals({ goodhartAuditPassed: false }),
    );
    expect(result.next).toBe("enforcement_pending");
    expect(result.reason).toContain("goodhart_audit_passed");
  });
});

describe("nextEnforcementState - enforced", () => {
  test("regresses to action_reversal_shadow when abort fires", () => {
    const result = nextEnforcementState(
      "enforced",
      passingSignals({ abortConditionMet: true }),
    );
    expect(result.next).toBe("action_reversal_shadow");
    expect(result.reason).toBe("abort_from_enforced");
  });

  test("stays in enforced when steady", () => {
    const result = nextEnforcementState("enforced", passingSignals({ abortConditionMet: false }));
    expect(result.next).toBe("enforced");
  });
});

describe("decisionFlipMode", () => {
  const cases: Array<[EnforcementState, "off" | "advisory" | "active"]> = [
    ["calibrating", "off"],
    ["observation_shadow", "off"],
    ["action_reversal_shadow", "advisory"],
    ["enforcement_pending", "off"],
    ["enforced", "active"],
  ];

  for (const [state, expected] of cases) {
    test("returns " + expected + " for " + state, () => {
      expect(decisionFlipMode(state)).toBe(expected);
    });
  }
});
