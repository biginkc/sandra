import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// Jarrad (2026-10-08): "I don't want to make any auto DNC decisions. It should
// go to hold." Only a BARE carrier STOP keyword suppresses automatically; every
// phrase match is held for a person. The gates still run BEFORE any Jev
// classification/dispatch.
describe("inbound keyword gates stay ahead of Jev; only a bare STOP suppresses", () => {
  const src = readFileSync(join(process.cwd(), "src/lib/messaging/inbound.ts"), "utf8");
  const phraseGate = src.indexOf("!isCarrierStopKeyword(bodyTrimmed) &&");
  const stopGate = src.indexOf("if (isCarrierStopKeyword(bodyTrimmed))");
  const dispatch = src.indexOf("await dispatchAiResponse(");

  it("finds all three anchors in order", () => {
    expect(phraseGate).toBeGreaterThan(-1);
    expect(stopGate).toBeGreaterThan(phraseGate);
    expect(dispatch).toBeGreaterThan(stopGate);
  });

  it("the phrase gate holds for a person and applies NO phone-level suppression", () => {
    const body = src.slice(phraseGate, stopGate);
    expect(body).not.toContain("applyPhoneLevelOptOut(");
    expect(body).toContain("holdPhraseOptOut(");
  });

  it("applies phone-level suppression inside the bare STOP gate", () => {
    const body = src.slice(stopGate, src.indexOf('keyword: "help"', stopGate));
    expect(body).toContain("applyPhoneLevelOptOut(");
    expect(body).toContain('keyword: "stop"');
  });

  it("the wrong-number gate never suppresses the phone (scope all is held)", () => {
    const wn = src.indexOf("if (WRONG_NUMBER_KEYWORDS.test(ev.body))");
    const body = src.slice(wn, src.indexOf("const insertOutcome", src.indexOf("keyword: \"wrong_number\"", wn)) + 400);
    expect(body).not.toContain("applyPhoneLevelOptOut(");
  });

  it("does not consult Jev classification before the gates", () => {
    expect(src.slice(0, stopGate)).not.toMatch(/classifyWithJev|sms-classification/);
  });
});
