import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// Q6 (Jarrad, 2026-10-08): below-threshold Jev outcomes go to human review,
// but the deterministic keyword STOP/DNC gates in inbound.ts are unchanged:
// they run BEFORE any Jev classification/dispatch and suppress immediately.
describe("inbound keyword gates stay ahead of Jev and suppress immediately", () => {
  const src = readFileSync(join(process.cwd(), "src/lib/messaging/inbound.ts"), "utf8");
  const dncGate = src.indexOf("if (DNC_KEYWORDS.test(ev.body))");
  const stopGate = src.indexOf("if (matchesStopKeyword(bodyTrimmed))");
  const dispatch = src.indexOf("await dispatchAiResponse(");

  it("finds all three anchors", () => {
    expect(dncGate).toBeGreaterThan(-1);
    expect(stopGate).toBeGreaterThan(dncGate);
    expect(dispatch).toBeGreaterThan(stopGate);
  });

  it("applies phone-level suppression inside the DNC gate", () => {
    const body = src.slice(dncGate, stopGate);
    expect(body).toContain("applyPhoneLevelOptOut(");
    expect(body).toContain('keyword: "dnc"');
  });

  it("applies phone-level suppression inside the STOP gate", () => {
    const body = src.slice(stopGate, src.indexOf('keyword: "help"', stopGate));
    expect(body).toContain("applyPhoneLevelOptOut(");
    expect(body).toContain('keyword: "stop"');
  });

  it("does not consult Jev classification before the gates", () => {
    expect(src.slice(0, stopGate)).not.toMatch(/classifyWithJev|sms-classification/);
  });
});
