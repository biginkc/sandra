import { describe, expect, it } from "vitest";

import { PhoneMasker, assertNoRealPhones, last10 } from "./mask";

const SALT = "unit-test-salt";

describe("last10", () => {
  it.each([
    ["+18165551234", "8165551234"],
    ["(816) 555-1234", "8165551234"],
    ["1-816-555-1234", "8165551234"],
    ["8165551234", "8165551234"],
  ])("%s", (raw, want) => expect(last10(raw)).toBe(want));
  it.each(["12345", "", null, undefined])("rejects %j", (raw) => expect(last10(raw)).toBeNull());
});

describe("PhoneMasker", () => {
  it("keeps the area code and lands in the 555 exchange", () => {
    const m = new PhoneMasker(SALT);
    const out = m.mask("+18165551234")!;
    expect(out).toMatch(/^\+1816555\d{4}$/);
  });
  it("is deterministic across instances and across formats", () => {
    const a = new PhoneMasker(SALT).mask("+19135550001");
    const b = new PhoneMasker(SALT).mask("(913) 555-0001");
    expect(a).toBe(b);
  });
  it("changes with the salt", () => {
    expect(new PhoneMasker("salt-aaaa").mask("+19135550001")).not.toBe(new PhoneMasker("salt-bbbb").mask("+19135550001"));
  });
  it("never returns the real number", () => {
    const m = new PhoneMasker(SALT);
    for (let i = 0; i < 200; i++) {
      const real = `+1816555${String(i).padStart(4, "0")}`;
      expect(m.mask(real)).not.toBe(real);
    }
  });
  it("is injective: distinct real numbers never share a masked number", () => {
    const m = new PhoneMasker(SALT);
    const seen = new Map<string, string>();
    for (let i = 0; i < 3000; i++) {
      const real = `+1816${String(2000000 + i)}`;
      const masked = m.mask(real)!;
      expect(seen.has(masked)).toBe(false);
      seen.set(masked, real);
    }
  });
  it("returns null for unparseable input", () => {
    expect(new PhoneMasker(SALT).mask("abc")).toBeNull();
  });
  it("leaves business (keep) numbers alone", () => {
    const m = new PhoneMasker(SALT, ["+18165559999"]);
    expect(m.maskOrKeep("+18165559999")).toBe("+18165559999");
    expect(m.maskOrKeep("+18165550001")).not.toBe("+18165550001");
  });
  it("requires a real salt", () => {
    expect(() => new PhoneMasker("")).toThrow();
  });
});

describe("maskText", () => {
  const m = new PhoneMasker(SALT, ["+18165559999"]);
  it("masks embedded phone numbers in several formats, keeping the rest verbatim", () => {
    const out = m.maskText("Call me at (816) 555-1234 or 913.555.7777, not 8165551234. Thx!");
    expect(out).not.toMatch(/555-1234|555\.7777|8165551234/);
    expect(out.startsWith("Call me at ")).toBe(true);
    expect(out.endsWith(" Thx!")).toBe(true);
    // same number in different formats maps to the same masked number
    const masked = m.mask("+18165551234")!.slice(2);
    expect(out.replace(/\D/g, "")).toContain(masked);
  });
  it("does not touch ordinary numbers, prices, zips or dates", () => {
    const t = "I want $185,000 for 1234 Main St, KC MO 64111. Closing 2026-10-07 at 3pm.";
    expect(m.maskText(t)).toBe(t);
  });
  it("keeps the business number", () => {
    expect(m.maskText("text us at 816-555-9999")).toBe("text us at 816-555-9999");
  });
});

describe("assertNoRealPhones", () => {
  const allowed = new Set(["8165559999"]);
  it("passes masked and business numbers", () => {
    expect(() =>
      assertNoRealPhones({ a: ["+18165550123", "+18165559999"], b: { c: "x 913-555-0001 y" } }, allowed),
    ).not.toThrow();
  });
  it("throws on a real-looking number anywhere, reporting the path but not the digits", () => {
    let message = "";
    try {
      assertNoRealPhones({ rows: [{ note: "ring 816-234-5678" }] }, allowed);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/rows\[0\]\.note/);
    expect(message).not.toMatch(/234-5678|2345678/);
  });
  it("ignores uuids and iso timestamps", () => {
    expect(() =>
      assertNoRealPhones(
        {
          id: "123e4567-e89b-12d3-a456-426614174000",
          at: "2026-10-07T15:04:05.123456+00:00",
        },
        allowed,
      ),
    ).not.toThrow();
  });
});

describe("maskText leaves ids and timestamps alone", () => {
  it("does not rewrite a uuid with a long digit run", () => {
    const m = new PhoneMasker(SALT);
    const id = "123e4567-e89b-12d3-a456-4266141740ab";
    expect(m.maskText(`ref ${id} at 2026-10-07T15:04:05Z`)).toBe(`ref ${id} at 2026-10-07T15:04:05Z`);
  });
});
