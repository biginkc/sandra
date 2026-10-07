import { describe, expect, it } from "vitest";

import {
  FLORIDA_MAX_TEXTS_PER_24H,
  checkFloridaCap,
  checkRecipientQuietHours,
  stateForPhone,
} from "./quiet-hours-recipient";

// 2026-10-07 (daylight time everywhere that observes it).
const at = (iso: string) => new Date(iso);

describe("stateForPhone", () => {
  it("maps a US area code to its state, whatever the formatting", () => {
    expect(stateForPhone("+18165551234")).toBe("MO");
    expect(stateForPhone("(816) 555-1234")).toBe("MO");
    expect(stateForPhone("1-937-555-0100")).toBe("OH");
    expect(stateForPhone("8135550100")).toBe("FL");
    expect(stateForPhone("+13105550100")).toBe("CA");
  });

  it("returns null for unmapped, non-US or malformed numbers", () => {
    expect(stateForPhone("+14165550100")).toBeNull(); // Toronto
    expect(stateForPhone("+18005550100")).toBeNull(); // toll-free
    expect(stateForPhone("555")).toBeNull();
    expect(stateForPhone("")).toBeNull();
    expect(stateForPhone(null)).toBeNull();
    expect(stateForPhone(undefined)).toBeNull();
  });

  it("covers every US state and DC", () => {
    const samples: Record<string, string> = {
      AL: "205", AK: "907", AZ: "602", AR: "501", CA: "415", CO: "303", CT: "203",
      DE: "302", DC: "202", FL: "305", GA: "404", HI: "808", ID: "208", IL: "312",
      IN: "317", IA: "515", KS: "913", KY: "502", LA: "504", ME: "207", MD: "410",
      MA: "617", MI: "313", MN: "612", MS: "601", MO: "314", MT: "406", NE: "402",
      NV: "702", NH: "603", NJ: "201", NM: "505", NY: "212", NC: "919", ND: "701",
      OH: "216", OK: "405", OR: "503", PA: "215", RI: "401", SC: "803", SD: "605",
      TN: "615", TX: "214", UT: "801", VT: "802", VA: "703", WA: "206", WV: "304",
      WI: "414", WY: "307",
    };
    for (const [state, code] of Object.entries(samples)) {
      expect(stateForPhone(`+1${code}5550100`)).toBe(state);
    }
  });
});

describe("checkRecipientQuietHours", () => {
  it("allows 8:00am-8:59pm recipient-local and refuses outside it", () => {
    // Kansas City (MO, Central, CDT = UTC-5).
    const phone = "+18165550100";
    expect(checkRecipientQuietHours(phone, at("2026-10-07T12:59:00Z"))).toMatchObject({
      ok: false,
      reason: "outside_window",
      state: "MO",
    }); // 7:59am
    expect(checkRecipientQuietHours(phone, at("2026-10-07T13:00:00Z"))).toMatchObject({ ok: true, state: "MO" }); // 8:00am
    expect(checkRecipientQuietHours(phone, at("2026-10-08T01:59:00Z"))).toMatchObject({ ok: true }); // 8:59pm
    expect(checkRecipientQuietHours(phone, at("2026-10-08T02:00:00Z"))).toMatchObject({
      ok: false,
      reason: "outside_window",
    }); // 9:00pm
  });

  it("uses the recipient's zone, not the property's or the server's", () => {
    // 10:30pm Pacific = 12:30am Central: California recipient is blocked even
    // though a Missouri property would be too; 9:30am Pacific passes while
    // 11:30am Central also would. The point: it follows the area code.
    expect(checkRecipientQuietHours("+13105550100", at("2026-10-08T05:30:00Z"))).toMatchObject({
      ok: false,
      state: "CA",
    });
    // 4:30pm Pacific / 6:30pm Central / 7:30pm Eastern: all open.
    expect(checkRecipientQuietHours("+13105550100", at("2026-10-07T23:30:00Z"))).toMatchObject({ ok: true });
    // 2:30am UTC = 7:30pm Pacific (open) but 9:30pm Eastern (closed).
    const t = at("2026-10-08T01:30:00Z");
    expect(checkRecipientQuietHours("+13105550100", t)).toMatchObject({ ok: true });
    expect(checkRecipientQuietHours("+12125550100", t)).toMatchObject({ ok: false });
  });

  it("applies the Florida 8am-8pm window", () => {
    // Tampa (813, Eastern, EDT = UTC-4).
    const phone = "+18135550100";
    expect(checkRecipientQuietHours(phone, at("2026-10-07T23:59:00Z"))).toMatchObject({ ok: true, state: "FL" }); // 7:59pm
    expect(checkRecipientQuietHours(phone, at("2026-10-08T00:00:00Z"))).toMatchObject({
      ok: false,
      reason: "outside_window",
      state: "FL",
    }); // 8:00pm: open elsewhere, closed in Florida
    expect(checkRecipientQuietHours(phone, at("2026-10-07T11:59:00Z"))).toMatchObject({ ok: false }); // 7:59am
    expect(checkRecipientQuietHours(phone, at("2026-10-07T12:00:00Z"))).toMatchObject({ ok: true }); // 8:00am
  });

  it("uses Central time for the Florida panhandle (850)", () => {
    // 7:30am Central = 12:30 UTC; 8:30am Eastern would already be open.
    expect(checkRecipientQuietHours("+18505550100", at("2026-10-07T12:30:00Z"))).toMatchObject({
      ok: false,
      state: "FL",
    });
    expect(checkRecipientQuietHours("+18505550100", at("2026-10-07T13:30:00Z"))).toMatchObject({ ok: true });
  });

  it("fails closed when the state cannot be resolved", () => {
    expect(checkRecipientQuietHours("+14165550100", at("2026-10-07T18:00:00Z"))).toEqual({
      ok: false,
      reason: "unknown_recipient_state",
      state: null,
      localTime: null,
    });
    expect(checkRecipientQuietHours(null, at("2026-10-07T18:00:00Z"))).toMatchObject({
      ok: false,
      reason: "unknown_recipient_state",
    });
  });

  it("flags Florida recipients so the caller can enforce the 24h cap", () => {
    expect(checkRecipientQuietHours("+18135550100", at("2026-10-07T18:00:00Z"))).toMatchObject({ ok: true, florida: true });
    expect(checkRecipientQuietHours("+18165550100", at("2026-10-07T18:00:00Z"))).toMatchObject({ ok: true, florida: false });
  });
});

describe("checkFloridaCap", () => {
  it("allows up to the cap and refuses the next text", () => {
    expect(FLORIDA_MAX_TEXTS_PER_24H).toBe(3);
    expect(checkFloridaCap(0)).toEqual({ ok: true });
    expect(checkFloridaCap(2)).toEqual({ ok: true });
    expect(checkFloridaCap(3)).toEqual({ ok: false, reason: "florida_cap", sentLast24h: 3 });
    expect(checkFloridaCap(7)).toMatchObject({ ok: false });
  });

  it("fails closed on an unknown count", () => {
    expect(checkFloridaCap(null)).toEqual({ ok: false, reason: "florida_cap_unknown", sentLast24h: null });
    expect(checkFloridaCap(Number.NaN)).toMatchObject({ ok: false });
  });
});
