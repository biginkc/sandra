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

describe("hardened phone scan", () => {
  const none = new Set<string>();
  it("fails on numeric phones in JSON", () => {
    expect(() => assertNoRealPhones({ a: { b: 9132223344 } }, none)).toThrow(/numeric phone/);
    expect(() => assertNoRealPhones({ a: [19132223344] }, none)).toThrow(/numeric phone/);
  });
  it("allows masked / business / ordinary numbers", () => {
    expect(() => assertNoRealPhones({ arv: 1234567, sqft: 1800, m: 9135550001, lat: 39.1 }, none)).not.toThrow();
    expect(() => assertNoRealPhones({ b: 8165559999 }, new Set(["8165559999"]))).not.toThrow();
  });
  it("fails on 7-digit local numbers", () => {
    expect(() => assertNoRealPhones("call 222-3344 later", none)).toThrow(/7-digit/);
    expect(() => assertNoRealPhones("call 555-0100 later", none)).not.toThrow();
  });
  it("fails on international formats, ignores short ids", () => {
    expect(() => assertNoRealPhones("ph +63 917 123 4567", none)).toThrow(/unmasked/);
    expect(() => assertNoRealPhones("ph +44 20 7946 0958", none)).toThrow(/unmasked/);
    expect(() => assertNoRealPhones("v+12 ok", none)).not.toThrow();
  });
  it("fails on a real +1 formatted number", () => {
    expect(() => assertNoRealPhones("+1 (913) 222-3344", none)).toThrow();
  });
  it("fails on unmasked emails only when PII masking is on", () => {
    expect(() => assertNoRealPhones("mail jo@gmail.com", none)).not.toThrow();
    expect(() => assertNoRealPhones("mail jo@gmail.com", none, { maskPii: true })).toThrow(/email/);
    expect(() => assertNoRealPhones("mail user-abc@example.invalid", none, { maskPii: true })).not.toThrow();
  });
});

describe("maskText covers 7-digit, international and emails", () => {
  const m = new PhoneMasker(SALT, [], true);
  it("masks 7-digit and international numbers so the assert passes", () => {
    const out = m.maskText("home 222-3344, abroad +63 917 123 4567 or +44 20 7946 0958");
    expect(out).not.toMatch(/222-3344|917 123|7946/);
    expect(() => assertNoRealPhones(out, new Set())).not.toThrow();
    expect(m.maskText("home 222-3344")).toBe(new PhoneMasker(SALT, [], true).maskText("home 222-3344"));
  });
  it("does not touch dates, uuids, money", () => {
    const t = "2026-10-07T12:00:00Z 11111111-1111-4111-8111-111111111111 $250,000 offer";
    expect(m.maskText(t)).toBe(t);
  });
  it("masks emails deterministically only with PII masking", () => {
    const a = m.maskText("write jo.doe@gmail.com now");
    expect(a).toMatch(/user-[0-9a-f]{10}@example\.invalid/);
    expect(a).toBe(new PhoneMasker(SALT, [], true).maskText("write jo.doe@gmail.com now"));
    expect(new PhoneMasker(SALT).maskText("jo.doe@gmail.com")).toBe("jo.doe@gmail.com");
  });
  it("masks names deterministically and numeric phones", () => {
    expect(m.maskName("first", "John")).toBe(new PhoneMasker(SALT, [], true).maskName("first", "John"));
    expect(m.maskName("first", "John")).not.toContain("John");
    expect(new PhoneMasker(SALT).maskName("first", "John")).toBe("John");
    const n = m.maskNumber(9132223344);
    expect(String(n)).toMatch(/^913555\d{4}$/);
    expect(m.maskNumber(1234567)).toBe(1234567);
  });
});

describe("assertNoRealPhones masked-email pseudonyms", () => {
  it("does not flag an all-digit masked email hash as a phone", () => {
    expect(() => assertNoRealPhones({ email: "user-9134441234@example.invalid" }, new Set(), { maskPii: true })).not.toThrow();
    expect(() => assertNoRealPhones({ email: "user-9134441234@example.invalid" }, new Set(), { maskPii: false })).toThrow();
    expect(() => assertNoRealPhones({ note: "call 913-444-1234 user-9134441234@example.invalid" }, new Set(), { maskPii: true })).toThrow();
  });
});
