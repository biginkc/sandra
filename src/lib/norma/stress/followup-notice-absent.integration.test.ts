import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { drainNormaFollowupNotices } from "../followup-notice";
import { Harness } from "./harness";
import { rng } from "./trace";

/**
 * Runtime prerequisite: the follow-up notifier must be a no-op on a database that has no norma_followup_reassignments
 * table (every database before cutover stage 2). This runs against a real Postgres through the same pg client the stress
 * gate uses, so the "table does not exist" error is Postgres's own (42P01). The table is dropped first so the test
 * means the same thing on a schema that already has it.
 */
let h: Harness;
beforeAll(async () => {
  h = await Harness.create(rng(303));
  await h.scratch.pool.query("drop table if exists public.norma_followup_reassignments cascade");
});
afterAll(async () => {
  await h?.close();
});

describe("follow-up notifier on a database without the reassignment table", () => {
  it("does nothing: no post, no error, no write to any call, task or drip row", async () => {
    const ctx = await h.lead({ enrollments: ["active"] });
    await h.requestCall(ctx, h.world.rep1);
    await h.finish(ctx);
    const snapshot = async () => JSON.stringify((await h.scratch.pool.query("select (select coalesce(max(seq),0) from stress.audit) as audit")).rows);
    const before = await snapshot();
    const post = vi.fn(async () => ({ ts: "1.1" }));
    const summary = await drainNormaFollowupNotices({ client: h.client("followup"), post });
    expect(summary).toMatchObject({ configured: true, tableAbsent: true, scanned: 0, sent: 0, failed: 0 });
    expect(post).not.toHaveBeenCalled();
    expect(await snapshot()).toBe(before);
    expect(h.reports.filter((r) => r.surface === "norma_followup_notice")).toEqual([]);
  });
});
