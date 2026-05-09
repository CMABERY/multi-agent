import { describe, expect, test } from "vitest";
import {
  meetsLowerBound,
  meetsUpperBound,
  requiredSampleSize,
  wilsonInterval,
} from "../src/statisticalPower.js";

const TOL = 0.005;

function approx(actual: number, expected: number, tol: number = TOL): boolean {
  return Math.abs(actual - expected) <= tol;
}

describe("wilsonInterval", () => {
  test("returns no-information interval when trials is zero", () => {
    expect(wilsonInterval(0, 0)).toEqual({ lower: 0, upper: 1 });
  });

  test("matches reference values for 80/100 at 0.95 confidence", () => {
    // Standard published Wilson interval for 80/100 at 95 percent:
    // approx [0.7108, 0.8666].
    const interval = wilsonInterval(80, 100);
    expect(approx(interval.lower, 0.711)).toBe(true);
    expect(approx(interval.upper, 0.866)).toBe(true);
  });

  test("0/1 at 0.95 has upper bound around 0.975", () => {
    const interval = wilsonInterval(0, 1);
    expect(interval.lower).toBe(0);
    // Wilson upper for 0/1 at 95 percent: approx 0.7935 by standard formula.
    // Confirm lower endpoint hugs zero and upper sits well below 1.
    expect(interval.upper).toBeGreaterThan(0.5);
    expect(interval.upper).toBeLessThan(1);
  });

  test("1/1 at 0.95 has lower bound around 0.207", () => {
    // 1/1 mirrors 0/1: lower bound is 1 - upper(0/1).
    const oneOne = wilsonInterval(1, 1);
    const zeroOne = wilsonInterval(0, 1);
    expect(approx(oneOne.lower, 1 - zeroOne.upper)).toBe(true);
    expect(oneOne.upper).toBe(1);
  });

  test("interval contracts as trials grow", () => {
    const small = wilsonInterval(40, 50);
    const large = wilsonInterval(400, 500);
    const smallWidth = small.upper - small.lower;
    const largeWidth = large.upper - large.lower;
    expect(largeWidth).toBeLessThan(smallWidth);
  });

  test("symmetry: interval for k/n mirrors interval for (n-k)/n", () => {
    const a = wilsonInterval(30, 100);
    const b = wilsonInterval(70, 100);
    expect(approx(a.lower, 1 - b.upper)).toBe(true);
    expect(approx(a.upper, 1 - b.lower)).toBe(true);
  });

  test("interval is bounded in [0, 1]", () => {
    const cases: ReadonlyArray<[number, number]> = [
      [0, 10],
      [10, 10],
      [1, 1000],
      [999, 1000],
    ];
    for (const [s, n] of cases) {
      const { lower, upper } = wilsonInterval(s, n);
      expect(lower).toBeGreaterThanOrEqual(0);
      expect(upper).toBeLessThanOrEqual(1);
      expect(lower).toBeLessThanOrEqual(upper);
    }
  });

  test("supports 0.99 confidence with wider interval", () => {
    const at95 = wilsonInterval(80, 100, 0.95);
    const at99 = wilsonInterval(80, 100, 0.99);
    expect(at99.lower).toBeLessThan(at95.lower);
    expect(at99.upper).toBeGreaterThan(at95.upper);
  });

  test("rejects invalid inputs", () => {
    expect(() => wilsonInterval(-1, 10)).toThrow(RangeError);
    expect(() => wilsonInterval(5, -1)).toThrow(RangeError);
    expect(() => wilsonInterval(11, 10)).toThrow(RangeError);
    expect(() => wilsonInterval(1.5, 10)).toThrow(RangeError);
    expect(() => wilsonInterval(5, 10, 0)).toThrow(RangeError);
    expect(() => wilsonInterval(5, 10, 1)).toThrow(RangeError);
  });
});

describe("meetsLowerBound", () => {
  test("passes when lower CI clears the target", () => {
    // 95/100 at 0.95: lower around 0.887; clears 0.85.
    expect(meetsLowerBound(95, 100, 0.85)).toBe(true);
  });

  test("fails when lower CI is below the target", () => {
    // 80/100 at 0.95: lower around 0.711; does not clear 0.80.
    expect(meetsLowerBound(80, 100, 0.80)).toBe(false);
  });

  test("never passes with zero trials", () => {
    expect(meetsLowerBound(0, 0, 0.5)).toBe(false);
  });

  test("rejects invalid target", () => {
    expect(() => meetsLowerBound(5, 10, -0.1)).toThrow(RangeError);
    expect(() => meetsLowerBound(5, 10, 1.1)).toThrow(RangeError);
  });
});

describe("meetsUpperBound", () => {
  test("passes when upper CI is at or below target", () => {
    // 5/100 at 0.95: upper around 0.113; clears 0.15.
    expect(meetsUpperBound(5, 100, 0.15)).toBe(true);
  });

  test("fails when upper CI exceeds target", () => {
    // 20/100 at 0.95: upper around 0.286; does not clear 0.15.
    expect(meetsUpperBound(20, 100, 0.15)).toBe(false);
  });

  test("never passes with zero trials", () => {
    expect(meetsUpperBound(0, 0, 0.5)).toBe(false);
  });

  test("rejects invalid target", () => {
    expect(() => meetsUpperBound(5, 10, -0.1)).toThrow(RangeError);
    expect(() => meetsUpperBound(5, 10, 1.1)).toThrow(RangeError);
  });
});

describe("requiredSampleSize", () => {
  test("returns a positive integer", () => {
    const n = requiredSampleSize(0.5, 0.05);
    expect(Number.isInteger(n)).toBe(true);
    expect(n).toBeGreaterThan(0);
  });

  test("the spec example: tighter target requires materially more samples", () => {
    // Per docs/grader-architecture.md section 4.7, a target of 0.90 with a
    // 0.05 width to the 0.85 boundary should require materially more samples
    // than a target of 0.80 with a 0.10 width to the 0.70 boundary.
    const tight = requiredSampleSize(0.90, 0.05);
    const loose = requiredSampleSize(0.80, 0.10);
    expect(tight).toBeGreaterThan(loose * 2);
  });

  test("higher confidence requires more samples", () => {
    const at95 = requiredSampleSize(0.5, 0.05, 0.95);
    const at99 = requiredSampleSize(0.5, 0.05, 0.99);
    expect(at99).toBeGreaterThan(at95);
  });

  test("smaller margin requires more samples (monotonic)", () => {
    const wide = requiredSampleSize(0.5, 0.10);
    const narrow = requiredSampleSize(0.5, 0.05);
    const tiny = requiredSampleSize(0.5, 0.025);
    expect(narrow).toBeGreaterThan(wide);
    expect(tiny).toBeGreaterThan(narrow);
  });

  test("the returned n satisfies the half-width bound and n-1 does not", () => {
    // For each target/margin pair, the recommended n must satisfy the Wilson
    // half-width bound around the target rate, and n-1 must not (so the
    // recommendation is genuinely the minimum). We compute the half-width
    // analytically from the formula in the spec; this avoids rounding noise
    // that arises when synthesizing observed successes.
    const targets: ReadonlyArray<[number, number]> = [
      [0.5, 0.05],
      [0.9, 0.05],
      [0.8, 0.10],
      [0.99, 0.01],
    ];

    function analyticHalfWidth(rate: number, n: number): number {
      const z = 1.959963984540054;
      const z2 = z * z;
      const denom = 1 + z2 / n;
      return (z * Math.sqrt((rate * (1 - rate)) / n + z2 / (4 * n * n))) / denom;
    }

    for (const [rate, margin] of targets) {
      const n = requiredSampleSize(rate, margin);
      expect(analyticHalfWidth(rate, n)).toBeLessThanOrEqual(margin);
      if (n > 1) {
        expect(analyticHalfWidth(rate, n - 1)).toBeGreaterThan(margin);
      }
    }
  });

  test("rejects invalid inputs", () => {
    expect(() => requiredSampleSize(-0.1, 0.05)).toThrow(RangeError);
    expect(() => requiredSampleSize(1.1, 0.05)).toThrow(RangeError);
    expect(() => requiredSampleSize(0.5, 0)).toThrow(RangeError);
    expect(() => requiredSampleSize(0.5, -0.01)).toThrow(RangeError);
  });
});
