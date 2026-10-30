import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/ai-responder/dispatch", () => ({ runRoutingV2OutboxReplies: vi.fn(), settleRoutingV2PhoneRepliesForCron: vi.fn() }));

import { handle } from "./handlers";

const req = (auth?: string) => new Request("https://x/api/cron/routing-v2-outbox", { headers: auth ? { authorization: auth } : {} });

describe("routing v2 outbox cron", () => {
  beforeEach(() => vi.stubEnv("CRON_SECRET", "s"));
  afterEach(() => vi.unstubAllEnvs());
  it("refuses without the cron secret and runs nothing", async () => {
    const replies = vi.fn();
    expect((await handle(req(), { client: () => ({}) as never, replies })).status).toBe(401);
    expect((await handle(req("Bearer wrong"), { client: () => ({}) as never, replies })).status).toBe(401);
    expect(replies).not.toHaveBeenCalled();
  });
  it("runs recovery + due replies, then the PR-G settler; a settler failure never hides the replies", async () => {
    const replies = vi.fn(async () => ({ released: 1, reconciled: { sent: 0, not_sent: 0, unknown: 0 }, results: [{ id: "o1", result: { kind: "sent" as const, receiptId: "m1" } }] }));
    const settle = vi.fn(async () => { throw new Error("boom"); });
    const res = await handle(req("Bearer s"), { client: () => ({}) as never, replies, settle });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, released: 1, delivered: [{ id: "o1", kind: "sent" }], settled: 0 });
    expect(replies).toHaveBeenCalledWith({}, { limit: 20 });
    expect(settle).toHaveBeenCalledOnce();
  });
});
