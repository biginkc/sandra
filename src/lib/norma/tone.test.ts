import { describe, expect, it } from "vitest";

import { NORMA_OUTCOMES } from "./types";
import { isNormaConnectedOutcome, normaOutcomeTone, normaRequestTone, NORMA_TONE_CLASSES } from "./tone";

describe("Norma call colours", () => {
  it.each([
    ["reached_no_callback", "green"],
    ["callback_requested", "green"],
    ["not_interested", "green"],
    ["wrong_number", "green"],
    ["no_answer", "neutral"],
    ["unknown", "amber"],
  ])("%s -> %s", (outcome, tone) => {
    expect(normaOutcomeTone(outcome)).toBe(tone);
  });

  it("covers every outcome, and anything missing or unrecognised is amber", () => {
    for (const outcome of NORMA_OUTCOMES) expect(["green", "neutral", "amber"]).toContain(normaOutcomeTone(outcome));
    for (const odd of [null, undefined, "", "something_new"]) expect(normaOutcomeTone(odd)).toBe("amber");
  });

  it("green means a person was reached; voicemail / no answer / busy never is", () => {
    expect(isNormaConnectedOutcome("no_answer")).toBe(false);
    expect(isNormaConnectedOutcome("unknown")).toBe(false);
    expect(isNormaConnectedOutcome(null)).toBe(false);
  });

  it("request rows: completed follows the outcome, review states are amber, in-flight is neutral", () => {
    expect(normaRequestTone("completed", "callback_requested")).toBe("green");
    expect(normaRequestTone("completed", "no_answer")).toBe("neutral");
    expect(normaRequestTone("needs_review", "unknown")).toBe("amber");
    expect(normaRequestTone("dispatch_unknown", null)).toBe("amber");
    for (const status of ["requested", "dispatching", "dispatched"]) expect(normaRequestTone(status, null)).toBe("neutral");
  });

  it("each tone has distinct classes (green uses the app's existing green tokens)", () => {
    expect(NORMA_TONE_CLASSES.green).toContain("#15803d");
    expect(NORMA_TONE_CLASSES.amber).toContain("amber");
    expect(new Set(Object.values(NORMA_TONE_CLASSES)).size).toBe(3);
  });
});
