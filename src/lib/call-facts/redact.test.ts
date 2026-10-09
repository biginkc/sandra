import { describe, expect, it } from "vitest";

import { assertNoKnownNames, finalizeRedacted, maskFactsInput, redactFactsInput, RedactionLeakError, type RedactionContext } from "./redact";
import { validateFacts } from "./validate";

const ctx = (lead: string[], rep: string[] = []): RedactionContext => ({ contactNames: lead, repNames: rep });
const t = (transcript: string, c: RedactionContext) => redactFactsInput({ summary: null, transcript }, c).transcript;
const sm = (summary: string, c: RedactionContext) => redactFactsInput({ summary, transcript: null }, c).summary;

describe("acceptance matrix (R rows; S and E rows are in the integration and end-to-end tests)", () => {
  it("matrix row 1: rep known only from app_metadata display_name, spoken whole and by first name", () => {
    expect(t("Speaker: this is Rick Rep, rick here", ctx([], ["Rick Rep", "ops7"]))).toBe("Speaker A: this is [name], [name] here");
  });
  it("matrix row 2: rep known only from user_metadata display_name, in the speaker prefix and the body", () => {
    expect(t("Dana Q: hi\nSomeone: ask for Dana", ctx([], ["Dana Q"]))).toBe("Rep: hi\nSpeaker A: ask for [name]");
  });
  it("matrix row 3: app and user names that differ are BOTH masked (no coalesce); a stoplist name is masked when Capitalized", () => {
    expect(t("Rich said Richard would call", ctx([], ["Richard Roe", "Rich"]))).toBe("[name] said [name] would call");
  });
  it("matrix row 4: rep known only from the email local part; the word 'will' is untouched", () => {
    expect(t("tom will text you", ctx([], ["tom.baker"]))).toBe("[name] will text you");
  });
  it("matrix row 5: rep from an identity (custom:hugo) name; the lowercase stoplist word 'lane' survives", () => {
    expect(t("Hugo Lane: ok\nSomeone: lane change", ctx([], ["Hugo Lane"]))).toBe("Rep: ok\nSpeaker A: lane change");
  });
  it("matrix row 6: a suspended or former member is masked", () => {
    expect(t("Sam called last week", ctx([], ["Sam Old"]))).toBe("[name] called last week");
  });
  it("matrix row 7: Dialpad's name for the rep differs from Sandra's; with and without the SQL source", () => {
    expect(t("Ricky R: hey\nSomeone: this is Ricky", ctx([], ["Rick Rep", "Ricky R"]))).toBe("Rep: hey\nSpeaker A: this is [name]");
    // Speaker-prefix harvest alone (Dialpad name never stored in Sandra):
    expect(t("Ricky R: hey\nthis is Ricky", ctx([], ["Rick Rep"]))).toBe("Speaker A: hey\nthis is [name]");
  });
  it("matrix row 8: a co-owner from property_contacts is masked", () => {
    expect(t("my sister Maria owns half", ctx(["Maria Gomez"]))).toBe("my sister [name] owns half");
  });
  it("matrix row 9: the dialed contact (not the homeowner) is the 'Other party'", () => {
    expect(t("Tom Heir: yes", ctx(["Tom Heir"]))).toBe("Other party: yes");
  });
  it("matrix row 10: possessives, straight and curly apostrophes and a plural possessive", () => {
    const c = ctx(["Sally"]);
    expect(t("it's Sally's house", c)).toBe("it's [name]'s house");
    expect(t("Sally’s house", c)).toBe("[name]'s house");
    expect(t("the Sallys' house", c)).toBe("the [name]'s house");
  });
  it("matrix row 11: hyphenated name as the whole form, as parts and in a possessive", () => {
    const c = ctx(["Seller-Jones"]);
    expect(t("Ms Seller Jones", c)).toBe("Ms [name]");
    expect(t("the Jones place", c)).toBe("the [name] place");
    expect(t("Seller-Jones's", c)).toBe("[name]'s");
  });
  it("matrix row 12: accented names mask completely, composed or decomposed", () => {
    const c = ctx(["José Núñez"]);
    expect(t("José called", c)).toBe("[name] called");
    expect(t("José called", c)).toBe("[name] called");
    expect(t("Núñez called", c)).toBe("[name] called");
  });
  it("matrix row 13: a two-letter name masks only when Capitalized", () => {
    const c = ctx(["Al Smith"]);
    expect(t("Al said", c)).toBe("[name] said");
    expect(t("al dente", c)).toBe("al dente");
  });
  it("matrix row 14: a stoplist surname masks Capitalized only, so the asking-price wording survives", () => {
    const out = redactFactsInput({ summary: null, transcript: "Mr Price wants a good price" }, ctx(["Bob Price"]));
    expect(out.transcript).toBe("Mr [name] wants a good price");
    expect(validateFacts({ asking_price: { value: "$1", evidence: "wants a good price" } }, { summary: null, transcript: out.transcript }, new Date())).toEqual({}); // value not in text
    expect(out.transcript).toContain("good price");
  });
  it("matrix row 15: an entity name masks whole; its generic words survive on their own", () => {
    expect(t("the Smith Family Trust owns it; family matters", ctx(["Smith Family Trust"]))).toBe("the [name] owns it; family matters");
  });
  it("matrix row 16: names inside the summary are masked", () => {
    expect(sm("Rick Rep spoke with Sally about Rick's offer", ctx(["Sally"], ["Rick Rep"]))).toBe("[name] spoke with [name] about [name]'s offer");
  });
  it("matrix row 17: the hard-coded rep map is masked even with no names from the database", () => {
    expect(t("Jarrad Henry here, jarrad again", ctx([]))).toBe("[name] here, [name] again");
  });
  it("matrix row 18: the leak scan throws when masking missed a known name, and the error never contains the name", () => {
    const c = ctx(["Sally"], ["Rick Rep"]);
    expect(() => finalizeRedacted({ summary: "Sally was here", transcript: null }, c)).toThrow(RedactionLeakError);
    try {
      finalizeRedacted({ summary: null, transcript: "Rep: call Rick" }, c);
      throw new Error("expected a leak");
    } catch (e) {
      expect(e).toBeInstanceOf(RedactionLeakError);
      expect((e as Error).message).not.toMatch(/sally|rick/i);
    }
    // Clean text passes, a stoplist word in lowercase is not a leak, a Capitalized one is.
    expect(() => assertNoKnownNames({ summary: "good price", transcript: null }, ctx(["Bob Price"]))).not.toThrow();
    expect(() => assertNoKnownNames({ summary: "Mr Price", transcript: null }, ctx(["Bob Price"]))).toThrow(RedactionLeakError);
  });
  // matrix row 19 (drift guard) is in 20261007190000_call_facts.integration.test.ts
});

describe("redaction rules", () => {
  it("rep, role labels and speakers: relabels prefixes and passes existing role labels through", () => {
    const out = t("Rick Rep: hello\nRep: again\nOther party: yes\nBob Neighbor: hmm\nbob neighbor: yes\nCarol X: no", ctx(["Sally"], ["Rick Rep"]));
    expect(out).toBe("Rep: hello\nRep: again\nOther party: yes\nSpeaker A: hmm\nSpeaker A: yes\nSpeaker B: no");
  });
  it("masks phone numbers in common formats", () => {
    for (const p of ["816-555-0142", "(816) 555-0142", "+1 816 555 0142", "816.555.0142", "8165550142"]) {
      expect(t(`Speaker: call me at ${p} ok`, ctx([]))).toBe("Speaker A: call me at [phone] ok");
    }
  });
  it("masks emails, even when the local part is a lead name", () => {
    expect(sm("write to jane.doe+x@mail-co.com now", ctx([]))).toBe("write to [email] now");
    expect(sm("mail sally@gmail.com please", ctx(["Sally"]))).toBe("mail [email] please");
  });
  it("masks US street addresses and the property address", () => {
    expect(t("S: I live at 4521 West Oak Street, ok", ctx([]))).toBe("Speaker A: I live at [address], ok");
    const c: RedactionContext = { contactNames: [], propertyAddress: { address: "1 Native Way", city: "Kansas City", zip: "64111" } };
    expect(sm("selling 1 Native Way, Kansas City 64111 soon", c)).toBe("selling [address] soon");
  });
  it("leaves dollar amounts and ordinary numbers alone", () => {
    const text = "Asking $185,000, owes $92,000.50 on 2 loans, wants 185k, 1,850,000 total, in 3 months";
    expect(sm(text, ctx(["Sally"]))).toBe(text);
  });
  it("a name is not masked inside a longer word, but a digit does not protect it", () => {
    expect(sm("Rickety fence, Rick2 said", ctx(["Rick"]))).toBe("Rickety fence, [name]2 said");
  });
  it("handles null input and lines without a speaker", () => {
    expect(redactFactsInput({ summary: null, transcript: null }, ctx([]))).toEqual({ summary: null, transcript: null });
    expect(t("no speaker here 816-555-0142", ctx([]))).toBe("no speaker here [phone]");
  });
  it("evidence quotes validate against the redacted text, and raw-only quotes do not", () => {
    const red = redactFactsInput({ summary: null, transcript: "Sally Seller-Jones: I want $185,000 and call 816-555-0142 about 1 Native Way" }, { contactNames: ["Sally", "Seller-Jones"], propertyAddress: { address: "1 Native Way" } });
    const quote = "I want $185,000 and call [phone] about [address]";
    expect(validateFacts({ asking_price: { value: "$185,000", evidence: quote } }, red, new Date()).asking_price).toEqual({ value: "$185,000", evidence: quote, amount_cents: 18_500_000 });
    expect(validateFacts({ asking_price: { value: "$185,000", evidence: "call 816-555-0142" } }, red, new Date()).asking_price).toBeUndefined();
  });
  it("maskFactsInput alone is not enough to be sent: only redactFactsInput / finalizeRedacted brand text", () => {
    const masked = maskFactsInput({ summary: "x", transcript: null }, ctx([]));
    // @ts-expect-error unbranded text cannot be passed where RedactedFactsInput is required
    const _brand: import("./redact").RedactedFactsInput = masked;
    void _brand;
  });
});
