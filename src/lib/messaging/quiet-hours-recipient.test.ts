import { describe, expect, it } from "vitest";

import {
  FLORIDA_MAX_TEXTS_PER_24H,
  MULTI_ZONE_AREA_CODES,
  checkFloridaCap,
  checkRecipientQuietHours,
  stateForPhone,
  zonesForAreaCode,
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

  it("an area code that spans zones must be open in EVERY zone", () => {
    // 850 (FL panhandle: Eastern + Central). 8:30pm Eastern = 7:30pm Central:
    // Florida's 8pm close has passed in the Eastern part -> refused.
    expect(checkRecipientQuietHours("+18505550100", at("2026-10-08T00:30:00Z"))).toMatchObject({
      ok: false,
      reason: "outside_window",
      state: "FL",
      localTime: "20:30",
    });
    // 7:30pm Eastern / 6:30pm Central: open in both.
    expect(checkRecipientQuietHours("+18505550100", at("2026-10-07T23:30:00Z"))).toMatchObject({ ok: true, florida: true });
    // 208 (Idaho: Mountain + Pacific). 7:30am Pacific = 8:30am Mountain -> refused.
    expect(checkRecipientQuietHours("+12085550100", at("2026-10-07T14:30:00Z"))).toMatchObject({
      ok: false,
      reason: "outside_window",
      state: "ID",
      localTime: "07:30",
    });
    // 8:30am Pacific / 9:30am Mountain: open in both.
    expect(checkRecipientQuietHours("+12085550100", at("2026-10-07T15:30:00Z"))).toMatchObject({ ok: true });
    // ...and the evening edge binds on the EASTERN-most zone: 9:30pm Mountain is closed even though 8:30pm Pacific is open.
    expect(checkRecipientQuietHours("+12085550100", at("2026-10-08T03:30:00Z"))).toMatchObject({ ok: false });
  });

  it("every other split-zone area code is checked against all of its zones", () => {
    // [phone, UTC instant, expected ok, why]. Times are in October 2026 (DST in effect except AZ).
    const cases: Array<[string, string, boolean]> = [
      ["+18125550100", "2026-10-07T12:30:00Z", false], // 812 IN: 7:30am Central (Evansville) though 8:30am Eastern
      ["+18125550100", "2026-10-07T13:30:00Z", true],
      ["+15745550100", "2026-10-08T01:30:00Z", false], // 574 IN: 9:30pm Eastern closed though 8:30pm Central
      ["+19065550100", "2026-10-07T12:30:00Z", false], // 906 MI: 7:30am Central (Wisconsin line)
      ["+16205550100", "2026-10-07T13:30:00Z", false], // 620 KS: 7:30am Mountain
      ["+17855550100", "2026-10-07T14:30:00Z", true],
      ["+13085550100", "2026-10-07T13:30:00Z", false], // 308 NE
      ["+16055550100", "2026-10-07T13:30:00Z", false], // 605 SD
      ["+17015550100", "2026-10-07T13:30:00Z", false], // 701 ND
      ["+15415550100", "2026-10-07T14:30:00Z", false], // 541 OR: 7:30am Pacific
      ["+14585550100", "2026-10-07T14:30:00Z", false], // 458 OR overlay
      ["+12705550100", "2026-10-08T01:30:00Z", false], // 270 KY: 9:30pm Eastern (Elizabethtown)
      ["+14235550100", "2026-10-07T12:30:00Z", false], // 423 TN: 7:30am Central
      ["+17755550100", "2026-10-07T14:30:00Z", false], // 775 NV: West Wendover
      ["+19285550100", "2026-10-08T03:30:00Z", false], // 928 AZ: 8:30pm Phoenix = 9:30pm Navajo (DST)
      ["+19075550100", "2026-10-07T16:30:00Z", false], // 907 AK: 8:30am Anchorage = 7:30am Adak
    ];
    for (const [phone, iso, ok] of cases) {
      expect(checkRecipientQuietHours(phone, at(iso)).ok, `${phone} @ ${iso}`).toBe(ok);
    }
  });

  it("single-zone corrections to the state default still hold", () => {
    expect(zonesForAreaCode("219")).toEqual(["America/Chicago"]);
    expect(zonesForAreaCode("865")).toEqual(["America/New_York"]);
    expect(zonesForAreaCode("915")).toEqual(["America/Denver"]);
    expect(zonesForAreaCode("816")).toEqual(["America/Chicago"]);
    expect(zonesForAreaCode("999")).toBeNull();
  });

  it("audit: the multi-zone table is exactly the reviewed list, and every zone is a valid IANA zone", () => {
    expect([...MULTI_ZONE_AREA_CODES].sort()).toEqual(
      [
        "208", "270", "308", "364", "423", "448", "458", "541", "574", "605", "620", "701", "775", "785",
        "812", "850", "906", "907", "928", "930", "986",
      ].sort(),
    );
    for (const code of MULTI_ZONE_AREA_CODES) {
      expect(stateForPhone(`+1${code}5550100`), code).not.toBeNull();
      for (const zone of zonesForAreaCode(code)!) {
        expect(() => new Intl.DateTimeFormat("en-US", { timeZone: zone }), `${code} ${zone}`).not.toThrow();
      }
    }
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
