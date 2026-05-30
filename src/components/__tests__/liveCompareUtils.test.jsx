import { describe, expect, it } from "vitest";
import { shouldShowMismatchStat } from "../liveCompareUtils.js";

describe("shouldShowMismatchStat", () => {
  it("hides the stat until mismatch exceeds the threshold", () => {
    expect(shouldShowMismatchStat(-1, 0.05)).toBe(false);
    expect(shouldShowMismatchStat(4.9, 0.05)).toBe(false);
    expect(shouldShowMismatchStat(5.1, 0.05)).toBe(true);
  });
});