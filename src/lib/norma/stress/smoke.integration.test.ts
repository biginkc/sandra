import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Harness } from "./harness";
import { rng } from "./trace";

let h: Harness;
beforeAll(async () => {
  h = await Harness.create(rng(1));
});
afterAll(async () => {
  await h?.close();
});

describe("harness smoke", () => {
  it("runs one callback call end to end", async () => {
    const ctx = await h.lead({ enrollments: ["active"] }, { kind: "callback", webhooksBeforeResponse: 1 });
    const res = await h.requestCall(ctx, h.world.rep1);
    expect(res.ok).toBe(true);
    const row = (await h.scratch.pool.query("select status, outcome, bland_call_id from public.norma_call_requests where property_id=$1", [ctx.lead.property])).rows[0];
    expect(row.status).toBe("completed");
    expect(row.outcome).toBe("callback_requested");
    await h.slackDrain();
    expect(h.slack.postsFor(ctx.lead.property)).toHaveLength(1);
  });
});
