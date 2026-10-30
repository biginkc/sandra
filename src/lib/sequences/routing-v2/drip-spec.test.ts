import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { renderTemplate } from "@/lib/templates/render";

import { APPROVED_DRIPS } from "./approved-drips.fixture";
import { ROUTING_V2_DRIPS } from "./drip-spec";
import { smsSegments } from "./sms-segments";

const MIGRATION = readFileSync(
  path.join(process.cwd(), "supabase/migrations/20261030140000_routing_v2_versioned_drips.sql"),
  "utf8",
);

/** Rows of the seed VALUES block: (key, idx, day, slot_window, $t$body$t$). */
function seedRows() {
  const re = /\('([a-z_]+)', (\d+), (\d+), (null|'[a-z]+'), \$t\$([\s\S]*?)\$t\$\)/g;
  return [...MIGRATION.matchAll(re)].map((m) => ({
    key: m[1]!,
    idx: Number(m[2]),
    day: Number(m[3]),
    slotWindow: m[4] === "null" ? null : m[4]!.slice(1, -1),
    body: m[5]!,
  }));
}

// "Mel"-voice texts are GSM-7; one segment = 160 chars.
const GSM7 = /^[A-Za-z0-9 @$_!"#%&'()*+,\-./:;<=>?\n\r]*$/;

describe("routing v2 drip seed pins", () => {
  it("the fixture is the approved vault text (counts per drip)", () => {
    expect(APPROVED_DRIPS.price_too_high).toHaveLength(7);
    expect(APPROVED_DRIPS.book_appointment_first6).toHaveLength(6);
    expect(APPROVED_DRIPS.said_theyd_call).toHaveLength(6);
    expect(APPROVED_DRIPS.vacant_land).toHaveLength(5);
  });

  it("migration seed rows equal the spec exactly (order, day, window, bytes)", () => {
    const expected = Object.entries(ROUTING_V2_DRIPS).flatMap(([key, d]) =>
      d.steps.map((s, idx) => ({ key, idx, day: s.day, slotWindow: s.slotWindow, body: s.body })),
    );
    expect(seedRows()).toEqual(expected);
  });

  it("non-booking texts are byte-for-byte the approved texts", () => {
    expect(ROUTING_V2_DRIPS.price_too_high.steps.map((s) => s.body)).toEqual([...APPROVED_DRIPS.price_too_high]);
    expect(ROUTING_V2_DRIPS.vacant_land.steps.map((s) => s.body)).toEqual([...APPROVED_DRIPS.vacant_land]);
    expect(ROUTING_V2_DRIPS.listed_not_selling.steps.map((s) => s.body)).toEqual([APPROVED_DRIPS.listed_not_selling_day2]);
  });

  it("booking texts differ from the approved texts ONLY by the clock time -> {{slot_time}}", () => {
    const pairs = [
      ...ROUTING_V2_DRIPS.book_appointment.steps.map((s, i) => [s.body, APPROVED_DRIPS.book_appointment_first6[i]!]),
      ...ROUTING_V2_DRIPS.said_theyd_call.steps.map((s, i) => [s.body, APPROVED_DRIPS.said_theyd_call[i]!]),
    ];
    for (const [seeded, approved] of pairs) {
      const time = approved!.match(/\b\d{1,2}:\d{2}\b/)![0];
      const [before, after] = approved!.split(time);
      expect(seeded).toBe(`${before}{{slot_time}}${after}`);
      expect(seeded!.match(/\{\{slot_time\}\}/g)).toHaveLength(1);
    }
  });

  it("schedules match the vault note", () => {
    expect(ROUTING_V2_DRIPS.price_too_high.steps.map((s) => s.day)).toEqual([30, 75, 135, 225, 315, 435, 555]);
    expect(ROUTING_V2_DRIPS.vacant_land.steps.map((s) => s.day)).toEqual([0, 30, 90, 180, 365]);
    expect(ROUTING_V2_DRIPS.said_theyd_call.steps.map((s) => s.day)).toEqual([1, 2, 3, 5, 7, 10]);
    expect(ROUTING_V2_DRIPS.book_appointment.steps.map((s) => s.day)).toEqual([1, 2, 4, 5, 7, 8]);
    expect(ROUTING_V2_DRIPS.listed_not_selling.steps.map((s) => s.day)).toEqual([2]);
    // Auto handoff at drip end is disabled pending Jarrad's decision: no drip names a next drip.
    for (const d of Object.values(ROUTING_V2_DRIPS)) expect(d.thenKey).toBeNull();
    expect(MIGRATION).toMatch(/v_then := null;/);
  });

  it("slot windows keep the words true", () => {
    for (const d of [ROUTING_V2_DRIPS.book_appointment, ROUTING_V2_DRIPS.said_theyd_call]) {
      for (const s of d.steps) {
        if (/this morning/.test(s.body)) expect(s.slotWindow).toBe("morning");
        else if (/afternoon/.test(s.body)) expect(s.slotWindow).toBe("afternoon");
        else expect(s.slotWindow).toBe("any");
      }
    }
  });

  it("seeds are inactive, no auto opt-out append (keeps one segment), and never touch legacy rows", () => {
    expect(MIGRATION).toMatch(/false, false, v_key, 1, v_then/);
    // The only UPDATE statements in the migration live inside the v2 FUNCTION bodies. Only
    // `as $$ ... $$;` function bodies are stripped, so the seed DO block stays visible.
    const outsideFunctions = MIGRATION.replace(/\bas \$\$[\s\S]*?\$\$;/g, "");
    expect(outsideFunctions).toMatch(/for r in select distinct org_id from public\.ai_responder_configs/);
    expect(outsideFunctions).toMatch(/insert into public\.sequence_steps/);
    expect(outsideFunctions).not.toMatch(/\bupdate\s+public\./i);
    expect(outsideFunctions).not.toMatch(/\bdelete\s+from\b/i);
  });
});

describe("routing v2 drips: one segment at typical sizes (11-char name, 28-char address)", () => {
  const all = Object.values(ROUTING_V2_DRIPS).flatMap((d) => d.steps.map((s) => s.body));
  const render = (body: string, name: string | null, address: string, slot = "12:45") =>
    renderTemplate(body, { first_name: name, property_address: address, slot_time: slot });

  it("is GSM-7 (no smart quotes / emoji that force UCS-2)", () => {
    for (const body of all) expect(render(body, "Christopher", "1234 Main St")).toMatch(GSM7);
  });

  it("fits 160 chars with a long name (11) and long address (28) and the widest slot time", () => {
    const address = "12345 W Longview Ridge Pkwy."; // 28 chars
    expect(address).toHaveLength(28);
    for (const body of all) {
      const text = render(body, "Christopher", address);
      expect(text.length, text).toBeLessThanOrEqual(160);
    }
  });

  it("fits with the 'there' fallback when the name is missing", () => {
    for (const body of all) expect(render(body, null, "12345 W Longview Ridge Pkwy.").length).toBeLessThanOrEqual(160);
  });

  it("Price too high #2 is the approved shortened text (SELF-APPROVED-TEXT-LOG row 6)", () => {
    expect(ROUTING_V2_DRIPS.price_too_high.steps[1]!.body).toBe(
      "Hi {{first_name | there}}, Mel with BMH. Any flexibility on your price for {{property_address}}?",
    );
  });
});

describe("routing v2 drips: segment counts with realistic long substitutions", () => {
  const all = Object.entries(ROUTING_V2_DRIPS).flatMap(([key, d]) =>
    d.steps.map((s, i) => ({ id: `${key}#${i + 1}`, body: s.body })),
  );
  const render = (body: string, name: string | null, address: string, slot = "12:45") =>
    renderTemplate(body, { first_name: name, property_address: address, slot_time: slot });
  const NAME_20 = "Maximiliano-Fernando"; // 20 chars
  const NAME_UCS2 = "Łukasz"; // Ł is not GSM-7
  const ADDR_105 =
    "12345 North Kansas City Boulevard Apartment Building C Unit 1402, Overland Park Township, KS 66213-4455"; // 103 chars
  const ADDR_MAX = `${ADDR_105}xx`; // 105 chars

  it("fixtures are the sizes they claim", () => {
    expect(NAME_20).toHaveLength(20);
    expect(ADDR_MAX).toHaveLength(105);
  });

  it("reports segments per text (GSM-7, 20-char name, 28 / 60 / 105-char address); addresses never truncated", () => {
    const addr28 = "12345 W Longview Ridge Pkwy.";
    const addr60 = "4821 Northeast Old Pleasant Valley Road Unit 12, Kansas City";
    expect(addr60).toHaveLength(60);
    const report = all.map(({ id, body }) => {
      const r28 = smsSegments(render(body, NAME_20, addr28));
      const r60 = smsSegments(render(body, NAME_20, addr60));
      const r105 = smsSegments(render(body, NAME_20, ADDR_MAX));
      return { id, encoding: r105.encoding, seg28: r28.segments, seg60: r60.segments, seg105: r105.segments, chars105: r105.units };
    });
    console.table(report);
    for (const r of report) {
      expect(r.encoding).toBe("GSM-7");
      expect(r.seg28).toBe(1); // every text fits one segment with a 28-char address
      expect(r.seg105).toBeLessThanOrEqual(2);
    }
    // Long addresses DO split some texts: not every input fits one segment.
    expect(report.some((r) => r.seg105 === 2)).toBe(true);
    // The rendered text always carries the full address.
    for (const { body } of all) {
      if (body.includes("{{property_address}}")) expect(render(body, NAME_20, ADDR_MAX)).toContain(ADDR_MAX);
    }
  });

  it("Price too high #2: exact counts", () => {
    const body = ROUTING_V2_DRIPS.price_too_high.steps[1]!.body;
    expect(smsSegments(render(body, NAME_20, "12345 W Longview Ridge Pkwy."))).toEqual({ encoding: "GSM-7", units: 102, segments: 1 });
    expect(smsSegments(render(body, NAME_20, ADDR_MAX))).toEqual({ encoding: "GSM-7", units: 179, segments: 2 });
  });

  it("a non-ASCII name forces UCS-2 (70-char segments)", () => {
    const body = ROUTING_V2_DRIPS.price_too_high.steps[1]!.body;
    // Short address: 68 UTF-16 units, still one 70-unit UCS-2 segment.
    expect(smsSegments(render(body, NAME_UCS2, "1 Elm St"))).toEqual({ encoding: "UCS-2", units: 68, segments: 1 });
    // A 28-char address pushes the same text past 70 units: 2 UCS-2 segments (one GSM-7 segment with "Lukasz").
    expect(smsSegments(render(body, NAME_UCS2, "12345 W Longview Ridge Pkwy."))).toEqual({ encoding: "UCS-2", units: 88, segments: 2 });
    const long = smsSegments(render(body, NAME_UCS2, ADDR_MAX));
    expect(long).toMatchObject({ encoding: "UCS-2" });
    expect(long.segments).toBe(Math.ceil(long.units / 67));
    // The same text with an ASCII name is one GSM-7 segment.
    expect(smsSegments(render(body, "Lukasz", "1 Elm St"))).toMatchObject({ encoding: "GSM-7", segments: 1 });
  });

  it("segment math edges", () => {
    expect(smsSegments("a".repeat(160))).toEqual({ encoding: "GSM-7", units: 160, segments: 1 });
    expect(smsSegments("a".repeat(161))).toEqual({ encoding: "GSM-7", units: 161, segments: 2 });
    expect(smsSegments("€".repeat(80)).segments).toBe(1); // extension chars cost 2
    expect(smsSegments("ł".repeat(70)).segments).toBe(1);
    expect(smsSegments("ł".repeat(71)).segments).toBe(2);
  });
});
