import { describe, expect, it } from "vitest";

import { isNearTranscriptBottom } from "./transcript-scroll";

describe("isNearTranscriptBottom", () => {
  it("is true when scrolled exactly to the bottom", () => {
    expect(isNearTranscriptBottom(400, 500, 100)).toBe(true);
  });

  it("is true within the default threshold", () => {
    expect(isNearTranscriptBottom(370, 500, 100)).toBe(true);
  });

  it("is false once scrolled up past the threshold", () => {
    expect(isNearTranscriptBottom(200, 500, 100)).toBe(false);
  });

  it("respects a custom threshold", () => {
    expect(isNearTranscriptBottom(340, 500, 100, 80)).toBe(true);
    expect(isNearTranscriptBottom(300, 500, 100, 20)).toBe(false);
  });
});
