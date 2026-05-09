import { createHash } from "node:crypto";

// These local type aliases mirror the canonical enums in src/schemas.ts
// (RiskLevelSchema and the grader_id enum). Kept local to avoid importing
// from schemas.ts so this module remains a pure, dependency-free utility.
// Keep these in sync if the canonical enums change.
type GraderId =
  | "reviewer_calibration"
  | "acceptance_criteria"
  | "intent"
  | "review_reasoning"
  | "output_quality";

type RiskLevel = "low" | "medium" | "high";

// Multi-character delimiter unlikely to appear in subject IDs, grader IDs, or
// rubric version strings used by the rest of the system.
const SAMPLING_DELIMITER = "::|::";
const SAMPLING_BUCKETS = 10000;

export interface ShouldSampleInput {
  subjectId: string;
  graderId: string;
  rubricVersion: string;
  rate: number;
}

export interface SamplingRateInput {
  graderId: GraderId;
  riskLevel: RiskLevel;
  reviewRequired?: boolean;
}

/**
 * Deterministic-by-hash sampling. Computes SHA-256 of
 * subjectId + delimiter + graderId + delimiter + rubricVersion, takes the first
 * 8 bytes as a uint64, then maps to a value in [0, 1) by computing
 * (value mod SAMPLING_BUCKETS) / SAMPLING_BUCKETS.
 *
 * Returns true when the resulting value is strictly less than the clamped rate.
 * A rate of 1.0 (or higher) always returns true; a rate of 0.0 (or lower)
 * never returns true. Rate is clamped to [0, 1].
 */
export function shouldSample(input: ShouldSampleInput): boolean {
  const clamped = clampRate(input.rate);
  if (clamped <= 0) {
    return false;
  }
  if (clamped >= 1) {
    return true;
  }

  const key = input.subjectId + SAMPLING_DELIMITER + input.graderId + SAMPLING_DELIMITER + input.rubricVersion;
  const digest = createHash("sha256").update(key).digest();

  // Take the first 8 bytes as a big-endian uint64. Use BigInt to avoid the
  // 53-bit safe-integer limit on JS numbers.
  const bucket = Number(digest.readBigUInt64BE(0) % BigInt(SAMPLING_BUCKETS));
  const value = bucket / SAMPLING_BUCKETS;
  return value < clamped;
}

// Per-grader, per-risk-tier sampling rates from spec section 4.6.
// Reviewer-Calibration is a flat 10 percent in this utility; full coverage on
// recheck triggers is enforced by the caller, not by this rate table.
// Output-Quality is computed dynamically because it depends on reviewRequired,
// not on risk tier.
const SAMPLING_RATES: Record<Exclude<GraderId, "output_quality">, Record<RiskLevel, number>> = {
  reviewer_calibration: { low: 0.10, medium: 0.10, high: 0.10 },
  acceptance_criteria: { low: 0.10, medium: 0.25, high: 1.0 },
  intent: { low: 0.25, medium: 1.0, high: 1.0 },
  review_reasoning: { low: 0.20, medium: 0.50, high: 1.0 }
};

/**
 * Returns the per-grader-per-risk-tier sampling rate from spec section 4.6.
 * Throws on unknown graderId or unknown riskLevel.
 */
export function samplingRateFor(input: SamplingRateInput): number {
  const { graderId, riskLevel } = input;

  if (!isKnownRiskLevel(riskLevel)) {
    throw new Error("Unknown riskLevel: " + String(riskLevel));
  }

  if (graderId === "output_quality") {
    const reviewRequired = input.reviewRequired ?? false;
    return reviewRequired ? 1.0 : 0.25;
  }

  const tiers = SAMPLING_RATES[graderId as Exclude<GraderId, "output_quality">];
  if (tiers === undefined) {
    throw new Error("Unknown graderId: " + String(graderId));
  }
  return tiers[riskLevel];
}

function clampRate(rate: number): number {
  if (Number.isNaN(rate) || rate < 0) {
    return 0;
  }
  if (rate > 1) {
    return 1;
  }
  return rate;
}

function isKnownRiskLevel(value: unknown): value is RiskLevel {
  return value === "low" || value === "medium" || value === "high";
}
