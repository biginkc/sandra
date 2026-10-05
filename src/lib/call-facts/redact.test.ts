import { describe, expect, it } from "vitest";

import { redactFactsInput, type RedactionContext } from "./redact";
import { validateFacts } from "./validate";

const ctx: RedactionContext = {
  contactNames: ["Sally", "Seller-Jones"],
  propertyAddress: { address: "1 Native Way", city: "Kansas City", zip: "64111" },
  repNames: ["Rick Rep"],
};
const r = (transcript: string | null, summary: string | null = null) => redactFactsInput({ summary, transcript }, ctx);

describe("redactFactsInput", () => {
  it("replaces speaker-name prefixes with role labels", () => {
    const out = r("Sally Seller-Jones: hi there\nRick Rep: hello\nBob Neighbor: hmm\nbob neighbor: yes\nCarol X: no").transcript!;
    expect(out).toBe("Other party: hi there\nRep: hello\nSpeaker A: hmm\nSpeaker A: yes\nSpeaker B: no");
  });

  it("masks phone numbers in common formats", () => {
    for (const p of ["816-555-0142", "(816) 555-0142", "+1 816 555 0142", "816.555.0142", "8165550142"]) {
      expect(r(`Speaker: call me at ${p} ok`).transcript).toBe("Speaker A: call me at [phone] ok");
    }
  });

  it("masks emails", () => {
    expect(r(null, "write to jane.doe+x@mail-co.com now").summary).toBe("write to [email] now");
  });

  it("masks US street addresses", () => {
    expect(r("S: I live at 4521 West Oak Street, ok").transcript).toBe("Speaker A: I live at [address], ok");
    expect(r(null, "owns 12 Elm Dr. and 900 N Main Ave").summary).toBe("owns [address] and [address]");
  });

  it("masks the lead's names (whole and parts) and the property address wherever they appear", () => {
    const out = r(null, "Sally said Seller-Jones wants out of 1 Native Way, Kansas City 64111. sally agrees.").summary!;
    expect(out).not.toMatch(/sally|seller-jones|native way|kansas city/i);
    expect(out).toContain("[address]");
    expect(out).toContain("[name]");
  });

  it("leaves dollar amounts and ordinary numbers alone", () => {
    const text = "Asking $185,000, owes $92,000.50 on 2 loans, wants 185k, 1,850,000 total, in 3 months";
    expect(r(null, text).summary).toBe(text);
  });

  it("handles null input and lines without a speaker", () => {
    expect(redactFactsInput({ summary: null, transcript: null }, ctx)).toEqual({ summary: null, transcript: null });
    expect(r("no speaker here 816-555-0142").transcript).toBe("no speaker here [phone]");
  });

  it("evidence quotes validate against the redacted text, and raw-only quotes do not", () => {
    const raw = { summary: null, transcript: "Sally Seller-Jones: I want $185,000 and call 816-555-0142 about 1 Native Way" };
    const red = redactFactsInput(raw, ctx);
    const quote = "I want $185,000 and call [phone] about [address]";
    const ok = validateFacts({ asking_price: { value: "185000", evidence: quote } }, red, new Date());
    expect(ok.asking_price?.value).toBe("$185,000");
    const leaked = validateFacts({ asking_price: { value: "185000", evidence: "call 816-555-0142" } }, red, new Date());
    expect(leaked.asking_price).toBeUndefined();
  });
});
