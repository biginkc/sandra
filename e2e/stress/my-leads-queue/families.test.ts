import { describe, expect, it } from "vitest";

import { FAMILIES, VARIANTS, WORDINGS, STAGE_CONTEXTS, buildFamilyWorld } from "./families";
import { place } from "./oracle";

describe("scenario families", () => {
  it("defines the 31 families of the design, uniquely named", () => {
    expect(FAMILIES).toHaveLength(31);
    expect(new Set(FAMILIES.map((f) => f.id)).size).toBe(31);
  });
  it("has 5 wordings x 3 stage contexts", () => {
    expect(WORDINGS).toHaveLength(5);
    expect(STAGE_CONTEXTS).toHaveLength(3);
    expect(VARIANTS).toHaveLength(15);
  });
  it.each(FAMILIES.map((f) => [f.id, f] as const))("%s is deterministic from the seed and places every lead", (_id, f) => {
    const a = buildFamilyWorld(f, 42, 3), b = buildFamilyWorld(f, 42, 3), c = buildFamilyWorld(f, 43, 3);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
    expect(a.leads.length).toBeGreaterThan(0);
    expect(new Set(a.leads.map((l) => l.key)).size).toBe(a.leads.length);
    for (const l of a.leads) expect(place(l, a.now).row).toBeTruthy();
  });
  it("covers every wording and every stage context in each ordinary family", () => {
    const w = buildFamilyWorld(FAMILIES.find((f) => f.id === "reply_drip_states")!, 1, 0);
    for (const x of WORDINGS) expect(w.leads.some((l) => l.tags?.includes(`wording:${x.id}`))).toBe(true);
    for (const x of STAGE_CONTEXTS) expect(w.leads.some((l) => l.tags?.includes(`stage:${x}`))).toBe(true);
  });
  it("the business-day boundary family straddles the 3-business-day deadline", () => {
    const w = buildFamilyWorld(FAMILIES.find((f) => f.id === "texted_last_bd_boundary")!, 5, 0);
    const rows = new Set(w.leads.map((l) => place(l, w.now).row));
    expect(rows).toEqual(new Set(["13", "14"]));
  });
  it("the callback boundary family straddles Due / Callback booked", () => {
    const w = buildFamilyWorld(FAMILIES.find((f) => f.id === "callback_boundary")!, 5, 0);
    expect(new Set(w.leads.map((l) => place(l, w.now).row))).toEqual(new Set(["4", "11"]));
  });
  it("never puts two messages of a lead at the same instant (database order of ties is random)", () => {
    for (const f of FAMILIES) for (let r = 0; r < 20; r += 1) {
      const w = buildFamilyWorld(f, 9, r);
      for (const l of w.leads) expect(new Set(l.messages.map((m) => m.at)).size, `${f.id} ${l.key}`).toBe(l.messages.length);
    }
  });
});
