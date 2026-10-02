import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Harness } from "./harness";
import { Latch, rng, sleep } from "./trace";

/**
 * Regression: simultaneous requests for one lead used to deadlock inside
 * fn_norma_create_request (property FOR SHARE vs the pause step's FOR NO KEY
 * UPDATE vs the one-open-request index). Exactly one request was still created,
 * but the 19 losers got database errors after a multi-second stall.
 */
let h: Harness;
beforeAll(async () => {
  h = await Harness.create(rng(21));
});
afterAll(async () => {
  await h?.close();
});

describe("simultaneous requests for one lead do not deadlock", () => {
  it.each([[false], [true], [true]])("20 presses (two users: %s): one request, 19 clean 'in flight' answers, no database errors, no stall", async (twoUsers) => {
    const hold = new Latch();
    const ctx = await h.lead({ enrollments: ["active"] }, { kind: "callback", hold: hold.promise });
    const started = Date.now();
    const presses = Array.from({ length: 20 }, (_, i) => h.requestCall(ctx, twoUsers && i % 2 ? h.world.rep2 : h.world.rep1, { actor: `rd-${i}` }));
    await sleep(400);
    hold.open();
    const results = await Promise.all(presses);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(results.filter((r) => r.ok && r.code === "calling")).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.code === "in_flight")).toHaveLength(19);
    const deadlocks = h.trace.events.filter((e) => (e.detail as { code?: string } | undefined)?.code === "40P01");
    expect(deadlocks).toEqual([]);
  });
});
