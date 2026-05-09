import { describe, expect, test } from "vitest";
import { samplingRateFor, shouldSample } from "../src/graderSampling.js";

/**
 * A small linear-congruential generator for reproducible "random" subject IDs.
 * Numbers used are the standard Numerical Recipes parameters.
 */
function makeLcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = Math.imul(state, 1664525);
    state = (state + 1013904223) >>> 0;
    return state;
  };
}

describe("shouldSample", () => {
  test("is deterministic across many calls for the same input", () => {
    const input = {
      subjectId: "subject-abc-123",
      graderId: "acceptance_criteria",
      rubricVersion: "v1",
      rate: 0.42
    };
    const first = shouldSample(input);
    for (let i = 0; i < 1000; i++) {
      expect(shouldSample(input)).toBe(first);
    }
  });

  test("rate of 1.0 always returns true", () => {
    for (let i = 0; i < 200; i++) {
      const ok = shouldSample({
        subjectId: "subject-" + i,
        graderId: "intent",
        rubricVersion: "v3",
        rate: 1.0
      });
      expect(ok).toBe(true);
    }
  });

  test("rate of 0.0 never returns true", () => {
    for (let i = 0; i < 200; i++) {
      const ok = shouldSample({
        subjectId: "subject-" + i,
        graderId: "intent",
        rubricVersion: "v3",
        rate: 0.0
      });
      expect(ok).toBe(false);
    }
  });

  test("clamps rate above 1.0 to always-true", () => {
    for (let i = 0; i < 50; i++) {
      const ok = shouldSample({
        subjectId: "subject-" + i,
        graderId: "intent",
        rubricVersion: "v3",
        rate: 1.5
      });
      expect(ok).toBe(true);
    }
  });

  test("clamps negative rate to never-true", () => {
    for (let i = 0; i < 50; i++) {
      const ok = shouldSample({
        subjectId: "subject-" + i,
        graderId: "intent",
        rubricVersion: "v3",
        rate: -0.1
      });
      expect(ok).toBe(false);
    }
  });

  test("rate distribution: 10000 IDs at rate 0.1 fall within [900, 1100]", () => {
    const rng = makeLcg(0xdeadbeef);
    const total = 10000;
    let sampled = 0;
    for (let i = 0; i < total; i++) {
      const subjectId = "subject-" + rng().toString(16) + "-" + i.toString(16);
      const ok = shouldSample({
        subjectId,
        graderId: "review_reasoning",
        rubricVersion: "v1",
        rate: 0.1
      });
      if (ok) {
        sampled++;
      }
    }
    expect(sampled).toBeGreaterThanOrEqual(900);
    expect(sampled).toBeLessThanOrEqual(1100);
  });

  test("different rubric versions produce independent decisions for the same subject", () => {
    let differences = 0;
    for (let i = 0; i < 200; i++) {
      const subjectId = "subject-" + i;
      const a = shouldSample({
        subjectId,
        graderId: "acceptance_criteria",
        rubricVersion: "v1",
        rate: 0.5
      });
      const b = shouldSample({
        subjectId,
        graderId: "acceptance_criteria",
        rubricVersion: "v2",
        rate: 0.5
      });
      if (a !== b) {
        differences++;
      }
    }
    // For uncorrelated 50/50 decisions across 200 trials, expect roughly 100
    // differences. Even a generous tolerance still proves the two streams are
    // not lockstep identical.
    expect(differences).toBeGreaterThan(50);
    expect(differences).toBeLessThan(150);
  });
});

describe("samplingRateFor", () => {
  test("reviewer_calibration returns 0.10 across risk tiers (recheck triggers out of scope)", () => {
    expect(samplingRateFor({ graderId: "reviewer_calibration", riskLevel: "low" })).toBe(0.10);
    expect(samplingRateFor({ graderId: "reviewer_calibration", riskLevel: "medium" })).toBe(0.10);
    expect(samplingRateFor({ graderId: "reviewer_calibration", riskLevel: "high" })).toBe(0.10);
  });

  test("acceptance_criteria rates by risk", () => {
    expect(samplingRateFor({ graderId: "acceptance_criteria", riskLevel: "high" })).toBe(1.0);
    expect(samplingRateFor({ graderId: "acceptance_criteria", riskLevel: "medium" })).toBe(0.25);
    expect(samplingRateFor({ graderId: "acceptance_criteria", riskLevel: "low" })).toBe(0.10);
  });

  test("intent rates by risk", () => {
    expect(samplingRateFor({ graderId: "intent", riskLevel: "high" })).toBe(1.0);
    expect(samplingRateFor({ graderId: "intent", riskLevel: "medium" })).toBe(1.0);
    expect(samplingRateFor({ graderId: "intent", riskLevel: "low" })).toBe(0.25);
  });

  test("review_reasoning rates by risk", () => {
    expect(samplingRateFor({ graderId: "review_reasoning", riskLevel: "high" })).toBe(1.0);
    expect(samplingRateFor({ graderId: "review_reasoning", riskLevel: "medium" })).toBe(0.50);
    expect(samplingRateFor({ graderId: "review_reasoning", riskLevel: "low" })).toBe(0.20);
  });

  test("output_quality is 1.0 on review-required regardless of risk", () => {
    expect(
      samplingRateFor({ graderId: "output_quality", riskLevel: "low", reviewRequired: true })
    ).toBe(1.0);
    expect(
      samplingRateFor({ graderId: "output_quality", riskLevel: "medium", reviewRequired: true })
    ).toBe(1.0);
    expect(
      samplingRateFor({ graderId: "output_quality", riskLevel: "high", reviewRequired: true })
    ).toBe(1.0);
  });

  test("output_quality is 0.25 when reviewRequired is false or undefined", () => {
    expect(
      samplingRateFor({ graderId: "output_quality", riskLevel: "low", reviewRequired: false })
    ).toBe(0.25);
    expect(
      samplingRateFor({ graderId: "output_quality", riskLevel: "medium", reviewRequired: false })
    ).toBe(0.25);
    expect(
      samplingRateFor({ graderId: "output_quality", riskLevel: "high", reviewRequired: false })
    ).toBe(0.25);
    // undefined treated as false
    expect(samplingRateFor({ graderId: "output_quality", riskLevel: "low" })).toBe(0.25);
    expect(samplingRateFor({ graderId: "output_quality", riskLevel: "medium" })).toBe(0.25);
    expect(samplingRateFor({ graderId: "output_quality", riskLevel: "high" })).toBe(0.25);
  });

  test("throws on unknown graderId", () => {
    expect(() =>
      samplingRateFor({
        // Cast to bypass the compile-time enum guard so we can assert the
        // runtime exception path.
        graderId: "not_a_real_grader" as unknown as Parameters<typeof samplingRateFor>[0]["graderId"],
        riskLevel: "high"
      })
    ).toThrow(/Unknown graderId/);
  });

  test("throws on unknown riskLevel", () => {
    expect(() =>
      samplingRateFor({
        graderId: "intent",
        riskLevel: "extreme" as unknown as Parameters<typeof samplingRateFor>[0]["riskLevel"]
      })
    ).toThrow(/Unknown riskLevel/);
  });
});
