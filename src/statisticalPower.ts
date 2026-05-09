// Wilson confidence interval utilities for binomial proportions.
//
// Pure functions; no IO, no side effects, no imports. Used by the Grader
// subsystem (see docs/grader-architecture.md section 4.7) to gate promotion
// thresholds of the form "rate at least p" or "rate at most p" against the
// 95 percent Wilson confidence interval over an observed sample, and to
// compute the minimum sample size needed for a target margin of error.

export interface WilsonInterval {
  lower: number;
  upper: number;
}

const DEFAULT_CONFIDENCE = 0.95;

// Hard-coded inverse normal CDF (z-score) for common confidence levels.
// Keys match the two-sided confidence level. The value is the z such that
// P(-z < Z < z) equals the confidence level for a standard normal Z.
const Z_TABLE: ReadonlyArray<{ confidence: number; z: number }> = [
  { confidence: 0.80, z: 1.2815515655446004 },
  { confidence: 0.90, z: 1.6448536269514722 },
  { confidence: 0.95, z: 1.959963984540054 },
  { confidence: 0.98, z: 2.3263478740408408 },
  { confidence: 0.99, z: 2.5758293035489004 },
  { confidence: 0.995, z: 2.807033768343811 },
  { confidence: 0.999, z: 3.2905267314918945 },
];

// Beasley-Springer-Moro rational approximation for the inverse normal CDF.
// Accurate to roughly 1e-7 across the central region; used as a fallback for
// confidence levels not present in Z_TABLE.
function inverseNormalCdfApprox(p: number): number {
  if (!(p > 0 && p < 1)) {
    throw new RangeError("inverseNormalCdf requires p in (0, 1); received " + String(p));
  }

  const a: ReadonlyArray<number> = [
    -3.969683028665376e+1,
    2.209460984245205e+2,
    -2.759285104469687e+2,
    1.383577518672690e+2,
    -3.066479806614716e+1,
    2.506628277459239e+0,
  ];
  const b: ReadonlyArray<number> = [
    -5.447609879822406e+1,
    1.615858368580409e+2,
    -1.556989798598866e+2,
    6.680131188771972e+1,
    -1.328068155288572e+1,
  ];
  const c: ReadonlyArray<number> = [
    -7.784894002430293e-3,
    -3.223964580411365e-1,
    -2.400758277161838e+0,
    -2.549732539343734e+0,
    4.374664141464968e+0,
    2.938163982698783e+0,
  ];
  const d: ReadonlyArray<number> = [
    7.784695709041462e-3,
    3.224671290700398e-1,
    2.445134137142996e+0,
    3.754408661907416e+0,
  ];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  // Index helpers tolerate noUncheckedIndexedAccess by coalescing undefined.
  const at = (arr: ReadonlyArray<number>, i: number): number => arr[i] ?? 0;

  let q: number;
  let r: number;

  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (
      ((((at(c, 0) * q + at(c, 1)) * q + at(c, 2)) * q + at(c, 3)) * q + at(c, 4)) * q + at(c, 5)
    ) / (
      (((at(d, 0) * q + at(d, 1)) * q + at(d, 2)) * q + at(d, 3)) * q + 1
    );
  }

  if (p <= pHigh) {
    q = p - 0.5;
    r = q * q;
    return (
      ((((at(a, 0) * r + at(a, 1)) * r + at(a, 2)) * r + at(a, 3)) * r + at(a, 4)) * r + at(a, 5)
    ) * q / (
      ((((at(b, 0) * r + at(b, 1)) * r + at(b, 2)) * r + at(b, 3)) * r + at(b, 4)) * r + 1
    );
  }

  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(
    ((((at(c, 0) * q + at(c, 1)) * q + at(c, 2)) * q + at(c, 3)) * q + at(c, 4)) * q + at(c, 5)
  ) / (
    (((at(d, 0) * q + at(d, 1)) * q + at(d, 2)) * q + at(d, 3)) * q + 1
  );
}

// Returns the two-sided z-score for a given confidence level. Looks up
// Z_TABLE first for stability on the values the spec cares about; falls back
// to the rational approximation for anything else.
function zForConfidence(confidence: number): number {
  if (!Number.isFinite(confidence) || confidence <= 0 || confidence >= 1) {
    throw new RangeError("confidence must be in (0, 1); received " + String(confidence));
  }
  for (const entry of Z_TABLE) {
    if (Math.abs(entry.confidence - confidence) < 1e-9) {
      return entry.z;
    }
  }
  // Two-sided: alpha = 1 - confidence; we want the (1 - alpha/2) quantile.
  const tailProbability = 1 - (1 - confidence) / 2;
  return inverseNormalCdfApprox(tailProbability);
}

function validateCount(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new RangeError(name + " must be a non-negative integer; received " + String(value));
  }
}

// Wilson score interval for the success probability of a binomial sample.
//
// trials === 0 returns { lower: 0, upper: 1 } (no information).
// successes must be in [0, trials]; otherwise throws RangeError.
export function wilsonInterval(
  successes: number,
  trials: number,
  confidence: number = DEFAULT_CONFIDENCE,
): WilsonInterval {
  validateCount("successes", successes);
  validateCount("trials", trials);
  if (trials === 0) {
    return { lower: 0, upper: 1 };
  }
  if (successes > trials) {
    throw new RangeError("successes (" + String(successes) + ") cannot exceed trials (" + String(trials) + ")");
  }

  const z = zForConfidence(confidence);
  const n = trials;
  const pHat = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (pHat + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((pHat * (1 - pHat)) / n + z2 / (4 * n * n))) / denom;

  const lower = Math.max(0, center - margin);
  const upper = Math.min(1, center + margin);
  return { lower, upper };
}

// True when the lower bound of the Wilson interval is at or above target.
// Used for "rate at least p" gates per spec section 4.7.
export function meetsLowerBound(
  successes: number,
  trials: number,
  target: number,
  confidence: number = DEFAULT_CONFIDENCE,
): boolean {
  if (!Number.isFinite(target) || target < 0 || target > 1) {
    throw new RangeError("target must be in [0, 1]; received " + String(target));
  }
  if (trials === 0) return false;
  const { lower } = wilsonInterval(successes, trials, confidence);
  return lower >= target;
}

// True when the upper bound of the Wilson interval is at or below target.
// Used for "rate at most p" gates per spec section 4.7.
export function meetsUpperBound(
  successes: number,
  trials: number,
  target: number,
  confidence: number = DEFAULT_CONFIDENCE,
): boolean {
  if (!Number.isFinite(target) || target < 0 || target > 1) {
    throw new RangeError("target must be in [0, 1]; received " + String(target));
  }
  if (trials === 0) return false;
  const { upper } = wilsonInterval(successes, trials, confidence);
  return upper <= target;
}

// Wilson half-width around an assumed targetRate for sample size n.
// Independent of observed successes; uses targetRate as the proportion
// estimate. Used by requiredSampleSize.
function wilsonHalfWidth(targetRate: number, n: number, z: number): number {
  const z2 = z * z;
  const denom = 1 + z2 / n;
  return (z * Math.sqrt((targetRate * (1 - targetRate)) / n + z2 / (4 * n * n))) / denom;
}

// Returns the minimum integer n such that the Wilson half-width around
// targetRate is at most marginOfError at the given confidence level.
//
// targetRate must be in [0, 1]. marginOfError must be in (0, 1].
// Uses binary search on the half-width, which is monotonically decreasing in n.
export function requiredSampleSize(
  targetRate: number,
  marginOfError: number,
  confidence: number = DEFAULT_CONFIDENCE,
): number {
  if (!Number.isFinite(targetRate) || targetRate < 0 || targetRate > 1) {
    throw new RangeError("targetRate must be in [0, 1]; received " + String(targetRate));
  }
  if (!Number.isFinite(marginOfError) || marginOfError <= 0 || marginOfError > 1) {
    throw new RangeError("marginOfError must be in (0, 1]; received " + String(marginOfError));
  }

  const z = zForConfidence(confidence);

  // n=1 may already satisfy the bound for trivial cases (targetRate at the
  // endpoints) since p*(1-p) is zero; the z2/(4n^2) term still contributes.
  if (wilsonHalfWidth(targetRate, 1, z) <= marginOfError) {
    return 1;
  }

  // Find an upper bound by doubling. The half-width shrinks as O(1/sqrt(n));
  // an explicit cap prevents pathological infinite loops on tiny tolerances.
  const maxN = 100_000_000;
  let high = 2;
  while (high < maxN && wilsonHalfWidth(targetRate, high, z) > marginOfError) {
    high *= 2;
  }
  if (wilsonHalfWidth(targetRate, high, z) > marginOfError) {
    return maxN;
  }

  // Binary search the smallest n in [low, high] satisfying the bound.
  // The doubling loop above guarantees high/2 did not satisfy the bound,
  // so low starts there.
  let low = Math.floor(high / 2);
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (wilsonHalfWidth(targetRate, mid, z) <= marginOfError) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }
  return low;
}
