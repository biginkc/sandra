import { describe, expect, it } from "vitest";

import { deriveTape, holdReasonSentence, reasonWord, tapeTagForRun, tapeTagForWord } from "./tape";
import type { PipelineRunStep, RunWithSteps } from "./types";

const step = (seq: number, kind: PipelineRunStep["kind"], name: string, result: PipelineRunStep["result"], detail: Record<string, unknown> = {}): PipelineRunStep => ({
  id: `s${seq}`, run_id: "r", org_id: "o", seq, kind, name, result, detail, created_at: "",
});
const run = (over: Partial<RunWithSteps> = {}): RunWithSteps => ({
  id: "r", org_id: "o", inbound_message_id: "m", property_id: null, contact_id: null, conversation_id: null,
  status: "closed", mode: "automatic", final_outcome: null, reason: null, classification_run_id: null, claim_id: null,
  outbound_message_id: null, inbound_preview: "x", started_at: "2026-10-14T12:00:00Z", completed_at: null, steps: [], ...over,
});

describe("tapeTagForWord", () => {
  it.each([
    ["new_lead", "Wants an offer"],
    ["nurture", "Maybe later"],
    ["not_interested", "Not interested"],
    ["wrong_number", "Wrong person"],
    ["opted_out", "Asked to stop"],
    ["dnc", "Asked to stop"],
    ["unclear", "Can't read it"],
    ["bad_number", "Can't read it"],
    ["hot_lead", "Wants an offer"],
    ["call_request", "Wants an offer"],
    ["price_or_offer", "Talked price"],
    ["hostile_needs_confirm", "Hostile"],
  ])("%s -> %s", (word, label) => {
    expect(tapeTagForWord(word)?.label).toBe(label);
  });
  it("returns null for an unknown word, never a made-up label", () => {
    expect(tapeTagForWord("something_new")).toBeNull();
    expect(tapeTagForWord(null)).toBeNull();
  });
});

describe("reasonWord", () => {
  it("strips the engine prefixes", () => {
    expect(reasonWord("model:price_or_offer")).toBe("price_or_offer");
    expect(reasonWord("keyword:price_offer")).toBe("price_offer");
    expect(reasonWord("jev_below_threshold:nurture")).toBe("nurture");
    expect(reasonWord("hostile_needs_confirm:abc")).toBe("hostile_needs_confirm");
    expect(reasonWord(null)).toBeNull();
  });
});

describe("tapeTagForRun", () => {
  it("prefers the escalation reason (price) over the classifier outcome (new_lead)", () => {
    const r = run({ reason: "model:price_or_offer", steps: [step(1, "jev", "classify", "pass", { outcome: "new_lead" })] });
    expect(tapeTagForRun(r)?.label).toBe("Talked price");
  });
  it("falls back to the terminal action when there is no classify step", () => {
    expect(tapeTagForRun(run({ steps: [step(1, "action", "apply_nurture", "applied")] }))?.label).toBe("Maybe later");
  });
});

describe("deriveTape", () => {
  it("running with no decision is 'reading'", () => {
    expect(deriveTape(run({ status: "running" }), "Martha").kind).toBe("reading");
  });

  it("not_interested with a sent reply reads like the approved example", () => {
    const v = deriveTape(
      run({ status: "closed", steps: [step(1, "jev", "classify", "pass", { outcome: "not_interested" }), step(2, "action", "not_interested", "applied"), step(3, "reply", "template_reply", "sent")] }),
      "Martha",
    );
    expect(v).toMatchObject({ kind: "decided", stage: "sent" });
    if (v.kind === "decided") {
      expect(v.sentence).toBe("Martha said no. Sent the thank-you and closed it.");
      expect(v.tag?.label).toBe("Not interested");
    }
  });

  it("a scheduled reply on a still-running run is 'Replying in a few minutes'", () => {
    const v = deriveTape(
      run({ status: "running", steps: [step(1, "jev", "classify", "pass", { outcome: "nurture" }), step(2, "action", "reply_delay_scheduled", "applied", { delaySeconds: 200 })] }),
      "Sue",
    );
    expect(v).toMatchObject({ kind: "decided", stage: "replying", did: expect.stringContaining("Replying in a few minutes") });
  });

  it("a promoted new lead is marked as a lead", () => {
    const v = deriveTape(run({ steps: [step(1, "jev", "classify", "pass", { outcome: "new_lead" }), step(2, "action", "promote_new_lead", "applied")] }), "Sue");
    expect(v).toMatchObject({ kind: "decided", tag: { label: "Wants an offer" }, did: "Marked as a lead" });
  });

  it("a drip shows its label and first-text date", () => {
    const v = deriveTape(
      run({ steps: [step(1, "jev", "classify", "pass", { outcome: "nurture" }), step(2, "reply", "template_reply", "sent"), step(3, "action", "drip_enrolled", "applied", { route: "maybe_later", firstSendNotBefore: "2026-11-06T15:00:00Z" })] }),
      "Marguerite",
    );
    expect(v.kind === "decided" && v.did).toContain("Drip started: Maybe later, first text Nov 6");
  });

  it("already_terminal skips become one quiet line", () => {
    const v = deriveTape(run({ status: "skipped", reason: "already_terminal", steps: [step(1, "gate", "already_terminal", "block")] }), "X");
    expect(v).toEqual({ kind: "quiet", text: "Already a lead, left for the person who owns it" });
  });

  it.each([
    ["no_property", /match this number to a property/],
    ["rep_sms_human_takeover", /person took over/],
    ["outside_business_hours", /Outside business hours/],
  ])("other skip %s gets its own short line", (reason, re) => {
    const v = deriveTape(run({ status: "skipped", reason }), "X");
    expect(v.kind === "quiet" && v.text).toMatch(re);
  });

  it("a held hostile text waits and says nothing was sent", () => {
    const v = deriveTape(run({ status: "held", reason: "hostile_needs_confirm:abc", steps: [step(1, "hold", "needs_confirm", "held")] }), "David");
    expect(v).toMatchObject({ kind: "decided", stage: "waiting", tag: { label: "Hostile" } });
  });

  it("never leaks engine step names into the sentence or the did line", () => {
    const names = ["claim", "resolve_threshold", "needs_attention", "luna_suggest"];
    const v = deriveTape(run({ status: "held", reason: "model:price_or_offer", steps: names.map((n, i) => step(i + 1, "action", n, "applied")) }), "Sue");
    const text = JSON.stringify(v);
    for (const n of names) expect(text).not.toContain(n);
    expect(text).not.toMatch(/gates? passed/);
  });

  it("an error run asks for a person without naming internals", () => {
    expect(deriveTape(run({ status: "error" }), "X").kind).toBe("error");
  });
});

describe("holdReasonSentence", () => {
  it("is plain English, never an engine code", () => {
    const s = holdReasonSentence(run({ reason: "model:price_or_offer" }), "model:price_or_offer", "Ryan");
    expect(s).toBe("Ryan asked about price. Nothing sent.");
    expect(holdReasonSentence(null, "send_timeout_then_sent", "They")).toBe("Needs a person to look at it. Nothing sent.");
  });
});
