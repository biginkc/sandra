import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { renderTemplate } from "@/lib/templates/render";

import { APPROVED_DRIPS } from "./approved-drips.fixture";
import { ROUTING_V2_DRIPS } from "./drip-spec";

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
    expect(ROUTING_V2_DRIPS.said_theyd_call.thenKey).toBe("book_appointment");
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
    // The only UPDATE statements in the migration live inside the v2 functions.
    const outsideFunctions = MIGRATION.replace(/\$\$[\s\S]*?\$\$/g, "");
    expect(outsideFunctions).not.toMatch(/\bupdate\s+public\./i);
    expect(outsideFunctions).not.toMatch(/\bdelete\s+from\b/i);
  });
});

describe("routing v2 drips stay one SMS segment", () => {
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

  it("documents the tightest text: Price too high #2 overflows past a 28-char address", () => {
    const tight = ROUTING_V2_DRIPS.price_too_high.steps[1]!.body;
    expect(render(tight, "Christopher", "12345 W Longview Ridge Pkwy.").length).toBe(160);
    expect(render(tight, "Christopher", "12345 W Longview Ridge Pkwy..").length).toBe(161);
  });
});
