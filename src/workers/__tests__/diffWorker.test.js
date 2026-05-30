import { describe, expect, it } from "vitest";
import { getMismatchPixelTint } from "../diffWorker.js";

describe("getMismatchPixelTint", () => {
  it("keeps mismatch pixels plain red", () => {
    expect(getMismatchPixelTint(0, 120)).toEqual({
      r: 255,
      g: 0,
      b: 0,
      a: 120,
    });

    expect(getMismatchPixelTint(29, 220)).toEqual({
      r: 255,
      g: 0,
      b: 0,
      a: 220,
    });
  });
});
