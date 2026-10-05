import { describe, expect, it, vi } from "vitest";

import { createJevFactsExtractor } from "./jev-facts";
import type { FactQuestionSlot } from "./questions";
import { runCallFactsSweep, type ClaimedCall } from "./run";

const claim = (over: Partial<ClaimedCall> = {}): ClaimedCall => ({
  fact_id: "f1", claim_token: "t1", call_activity_id: "a1",
  summary: "Seller wants about 185k.", transcript: "Seller: I want about 185k", ...over,
});
const NOW = () => new Date("2026-10-05T15:00:00Z");

describe("runCallFactsSweep", () => {
  it("with no extractor it completes every claim as no_facts (summary note only)", async () => {
    const complete = vi.fn(async () => undefined);
    const out = await runCallFactsSweep(3, { claim: async () => ({ claims: [claim()], exhausted: [] }), complete, extractor: null, now: NOW });
    expect(out).toEqual({ claimed: 1, completed: 1, failed: 0, exhausted: 0 });
    expect(complete).toHaveBeenCalledWith({ factId: "f1", claimToken: "t1", facts: {}, status: "no_facts", model: null });
  });

  it("validates the extractor's output in code: an unquoted fact is dropped, a quoted one survives", async () => {
    const complete = vi.fn(async () => undefined);
    const extractor = vi.fn(async () => ({
      model: "m",
      facts: { asking_price: { value: "185k", evidence: "I want about 185k" }, motivation: { value: "divorce", evidence: "going through a divorce" } },
    }));
    await runCallFactsSweep(3, { claim: async () => ({ claims: [claim()], exhausted: [] }), complete, extractor, now: NOW });
    expect(complete).toHaveBeenCalledWith({ factId: "f1", claimToken: "t1", facts: { asking_price: { value: "$185,000", evidence: "I want about 185k" } }, status: "proposed", model: "m" });
  });

  it("all fields dropped is no_facts", async () => {
    const complete = vi.fn(async () => undefined);
    const extractor = async () => ({ model: "m", facts: { motivation: { value: "x", evidence: "never said" } } });
    await runCallFactsSweep(3, { claim: async () => ({ claims: [claim()], exhausted: [] }), complete, extractor, now: NOW });
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ facts: {}, status: "no_facts", model: "m" }));
  });

  it("an extractor or completion failure leaves the lease to expire and keeps going", async () => {
    const report = vi.fn();
    const complete = vi.fn(async () => undefined);
    let n = 0;
    const extractor = vi.fn(async () => {
      if (++n === 1) throw new Error("boom");
      return { model: "m", facts: {} };
    });
    const out = await runCallFactsSweep(3, {
      claim: async () => ({ claims: [claim(), claim({ fact_id: "f2", claim_token: "t2" })], exhausted: [] }),
      complete, extractor, now: NOW, report,
    });
    expect(out).toMatchObject({ claimed: 2, completed: 1, failed: 1 });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("alerts once per exhausted row", async () => {
    const report = vi.fn();
    const out = await runCallFactsSweep(3, {
      claim: async () => ({ claims: [], exhausted: [{ fact_id: "f9", call_activity_id: "a9" }] }),
      complete: vi.fn(), extractor: null, now: NOW, report,
    });
    expect(out.exhausted).toBe(1);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("an empty call (no summary, no transcript) skips the extractor", async () => {
    const extractor = vi.fn();
    const complete = vi.fn(async () => undefined);
    await runCallFactsSweep(3, { claim: async () => ({ claims: [claim({ summary: null, transcript: null })], exhausted: [] }), complete, extractor, now: NOW });
    expect(extractor).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ status: "no_facts", model: null }));
  });
});

describe("runCallFactsSweep redaction", () => {
  it("sends only redacted text to the extractor and validates evidence against that same text", async () => {
    const complete = vi.fn(async () => undefined);
    const extractor = vi.fn(async (input: { summary: string | null; transcript: string | null }) => {
      expect(JSON.stringify(input)).not.toMatch(/Sally|816|Elm|sally@/i);
      return { model: "m", facts: { asking_price: { value: "185k", evidence: "Other party: I want 185k" }, motivation: { value: "x", evidence: "Sally: I want 185k" } } };
    });
    await runCallFactsSweep(3, {
      claim: async () => ({
        claims: [claim({ summary: "Sally at 12 Elm Dr, 816-555-0142", transcript: "Sally: I want 185k", contact_names: ["Sally"], property_address: "12 Elm Dr" })],
        exhausted: [],
      }),
      complete, extractor, now: NOW,
    });
    expect(extractor).toHaveBeenCalledTimes(1);
    // The raw-name evidence is not in the redacted text, so it is dropped; the redacted quote survives.
    const call = (complete.mock.calls[0] as unknown as [{ facts: Record<string, unknown> }])[0];
    expect(Object.keys(call.facts)).toEqual(["asking_price"]);
  });
});

describe("runCallFactsSweep with Jev", () => {
  it("redacts BEFORE Jev: the request carries no name, phone, email or address, and the chosen turn validates against the redacted text", async () => {
    const complete = vi.fn(async () => undefined);
    const ask = vi.fn(async (req: { state: unknown; questions: Record<string, unknown> }) => {
      expect(JSON.stringify(req)).not.toMatch(/Sally|816|Elm|sally@/i);
      return { asking_price: { choice: "T001|185k" } };
    });
    const slots: FactQuestionSlot[] = [{ id: "asking_price", field: "asking_price", label: "Asking price", kind: "amount", text: "TEST-ONLY q" }];
    await runCallFactsSweep(3, {
      claim: async () => ({
        claims: [claim({ summary: null, transcript: "Sally Seller: I want 185k, call 816-555-0142 or sally@x.com, I live at 12 Elm Dr", contact_names: ["Sally"], property_address: "12 Elm Dr" })],
        exhausted: [],
      }),
      complete, extractor: createJevFactsExtractor(ask, { questions: slots }), now: NOW,
    });
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      model: "jev-1.13.0",
      status: "proposed",
      facts: { asking_price: { value: "$185,000", evidence: "I want 185k, call [phone] or [email], I live at [address]" } },
    }));
  });
});
