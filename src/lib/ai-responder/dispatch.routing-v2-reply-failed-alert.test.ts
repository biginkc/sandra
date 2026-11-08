import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

import { enqueueV2ReplyFailedAlert, v2ReplyFailedAlertKey } from "./dispatch";

/** Synthetic rows only: a queued reply that could not be sent queues one reply_failed owner alert. */
function fake(opts: { src?: Record<string, unknown> | null; existing?: unknown[]; insertError?: string } = {}) {
  const inserts: Array<Record<string, unknown>> = [];
  const filters: Array<[string, unknown]> = [];
  const src = opts.src === undefined
    ? { org_id: "org1", property_id: "p1", inbound_message_id: "in1", transition_seq: 7, kind: "reply" }
    : opts.src;
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = (k: string, v: unknown) => (filters.push([k, v]), chain);
  chain.maybeSingle = async () => ({ data: src, error: null });
  chain.limit = async () => ({ data: opts.existing ?? [], error: null });
  chain.insert = async (row: Record<string, unknown>) => (inserts.push(row), { error: opts.insertError ? { message: opts.insertError } : null });
  return { client: { from: () => chain } as never, inserts, filters };
}

describe("enqueueV2ReplyFailedAlert", () => {
  it("queues one alert row on the failed reply's transition, never time-only gated, own dedupe key", async () => {
    const f = fake();
    expect(await enqueueV2ReplyFailedAlert(f.client, "box1")).toBe("queued");
    expect(f.inserts).toEqual([{
      org_id: "org1", property_id: "p1", inbound_message_id: "in1", transition_seq: 7, kind: "alert", engine: "v2", slice: "replies",
      payload: { reason: "reply_failed", label: "Reply could not be sent — needs a person", dedupe_key: "routing_v2:in1:reply_failed", when_time_only_off: false },
    }]);
    expect(v2ReplyFailedAlertKey("in1")).not.toMatch(/^hot_text/);
  });

  it("idempotent: an existing reply_failed alert for the inbound is not queued again", async () => {
    const f = fake({ existing: [{ id: "a1" }] });
    expect(await enqueueV2ReplyFailedAlert(f.client, "box1")).toBe("exists");
    expect(f.inserts).toEqual([]);
    expect(f.filters).toContainEqual(["payload->>dedupe_key", "routing_v2:in1:reply_failed"]);
  });

  it("only for reply rows; a missing row is skipped", async () => {
    expect(await enqueueV2ReplyFailedAlert(fake({ src: { org_id: "o", property_id: "p", inbound_message_id: "i", transition_seq: 1, kind: "alert" } }).client, "b")).toBe("skipped");
    expect(await enqueueV2ReplyFailedAlert(fake({ src: null }).client, "b")).toBe("skipped");
  });

  it("an insert error is reported, never thrown", async () => {
    expect(await enqueueV2ReplyFailedAlert(fake({ insertError: "boom" }).client, "b")).toBe("error");
  });
});
