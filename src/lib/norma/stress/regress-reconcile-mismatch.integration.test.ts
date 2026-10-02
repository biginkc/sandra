import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Harness } from "./harness";
import { rng } from "./trace";

/**
 * Regression tests for real bugs the stress gate found. Each one failed before
 * its fix (the commit message of each fix says which).
 */
let h: Harness;
beforeAll(async () => {
  h = await Harness.create(rng(7));
});
afterAll(async () => {
  await h?.close();
});

const q = async (sql: string, params: unknown[] = []) => (await h.scratch.pool.query(sql, params)).rows;
const requestOf = async (property: string) => (await q("select * from public.norma_call_requests where property_id = $1 order by created_at desc limit 1", [property]))[0];
const tasksOf = async (requestId: string) => q("select * from public.tasks where source_key = $1", [`norma_call:${requestId}`]);

describe("a Bland lookup that keeps disagreeing with the request", () => {
  it.each(["mismatch_key", "mismatch_number", "mismatch_call_id"] as const)(
    "%s: never applied, and the request still reaches needs_review within the window",
    async (lookup) => {
      const ctx = await h.lead({ enrollments: ["active"] }, { kind: "callback", lookup });
      expect(await h.requestCall(ctx, h.world.rep1)).toMatchObject({ ok: true, code: "calling" });
      // No webhook ever arrives; only the reconciliation sweep can resolve it.
      let status = "dispatched";
      for (let i = 0; i < 16 && status !== "needs_review"; i += 1) {
        await h.advance(5 * 60_000);
        await h.reconcile();
        status = (await requestOf(ctx.lead.property)).status;
        expect(status).not.toBe("completed");
      }
      expect(status).toBe("needs_review");
      expect((await q("select status from public.sequence_enrollments where id = $1", [ctx.lead.enrollments[0]]))[0].status).toBe("paused");
    },
  );
});
