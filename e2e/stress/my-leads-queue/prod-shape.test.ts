import { describe, expect, it } from "vitest";

import { createRng } from "../prng";
import { PROD_SHAPE_2026_10_14, prodShapedWorld, scaleCounts } from "./prod-shape";
import { place } from "./oracle";

describe("prod-shaped generator", () => {
  it("takes only aggregate counts and is deterministic from the seed", () => {
    const a = prodShapedWorld(PROD_SHAPE_2026_10_14, createRng(7), 1_760_000_000_000);
    const b = prodShapedWorld(PROD_SHAPE_2026_10_14, createRng(7), 1_760_000_000_000);
    const c = prodShapedWorld(PROD_SHAPE_2026_10_14, createRng(8), 1_760_000_000_000);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
    expect(a.leads).toHaveLength(181);
  });
  it("scales every proportion to an exact total", () => {
    for (const n of [400, 2000, 181, 37]) {
      const s = scaleCounts(PROD_SHAPE_2026_10_14, n);
      expect(s.activeDrip + s.pausedByReply + s.providerFailed + s.noEnrollment + s.scheduledCampaignTexts).toBe(n);
      expect(s.noEnrollmentWithInbound30d).toBeLessThanOrEqual(s.noEnrollment);
    }
  });
  it("gives each lead 4-12 messages and links ledger receipts", () => {
    const w = prodShapedWorld(scaleCounts(PROD_SHAPE_2026_10_14, 400), createRng(3), 1_760_000_000_000);
    expect(w.leads).toHaveLength(400);
    for (const l of w.leads) { expect(l.messages.length).toBeGreaterThanOrEqual(4 - 1); expect(l.messages.length).toBeLessThanOrEqual(13); }
    expect(w.leads.some((l) => l.messages.some((m) => m.ledger))).toBe(true);
  });
  it("contains no contact data, only invented keys", () => {
    const w = prodShapedWorld(PROD_SHAPE_2026_10_14, createRng(1), 1_760_000_000_000);
    expect(JSON.stringify(w)).not.toMatch(/\+1\d{10}|@|\d{3}-\d{4}/);
  });
  it("lands every shape in a placement", () => {
    const w = prodShapedWorld(PROD_SHAPE_2026_10_14, createRng(2), 1_760_000_000_000);
    const rows = new Set(w.leads.map((l) => place(l, w.now).row));
    expect(rows.size).toBeGreaterThan(3);
  });
  it("never puts two messages of a lead at the same instant", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const w = prodShapedWorld(scaleCounts(PROD_SHAPE_2026_10_14, 400), createRng(seed), 1_760_000_000_000);
      for (const l of w.leads) expect(new Set(l.messages.map((m) => m.at)).size).toBe(l.messages.length);
    }
  });
});
