import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
vi.mock("server-only", () => ({}));
import { createSelectionReviewRepository, parseSelectionReview, type SelectionReviewClient } from "./selection-review";
const org = "11111111-1111-4111-8111-111111111111", user = "22222222-2222-4222-8222-222222222222", session = "33333333-3333-4333-8333-333333333333";
const target = { kind: "conversation" as const, id: "44444444-4444-4444-8444-444444444444" };
const input = { orgId: org, filter: { view: "unread" as const }, targets: [target], generation: session };
const authority = { user_id: user, org_id: org, session_id: session, access_epoch: "4", session_active: true, active_membership_count: 1, expires_at: "2099-01-01T00:00:00Z" };
function fixture(overrides: Record<string, unknown> = {}, after: Record<string, unknown> = authority) {
  let authorizations = 0;
  const rpc = vi.fn((name: string) => ({ abortSignal: async () => ({ error: null, data: name === "inbox_authorize_sync" ? (++authorizations === 1 ? authority : after) : {
    org_id: org, requester_id: user, session_id: session, access_epoch: "4", items: [{ ...target, status: "outside_filter", name: "Ada" }], ...overrides,
  } }) }));
  return { rpc, review: createSelectionReviewRepository({ rpc } as unknown as SelectionReviewClient) };
}
describe("authoritative selection review", () => {
  it("rejects extra fields, duplicate targets and oversized batches before any RPC", () => {
    for (const value of [{ ...input, requesterId: user }, { ...input, targets: [target, target] }, { ...input, targets: Array(101).fill(target) }, { ...input, filter: { view: "all", injected: true } }]) {
      expect(() => parseSelectionReview(value)).toThrow();
    }
    expect(parseSelectionReview(input)).toEqual(input);
  });
  it("returns authoritative names and filter classification with bound generation", async () => {
    const f = fixture();
    expect(await f.review(input, new AbortController().signal)).toEqual({ orgId: org, requesterId: user, sessionId: session, accessEpoch: "4", generation: session, items: [{ ...target, status: "outside_filter", name: "Ada" }] });
    expect(f.rpc).toHaveBeenCalledWith("inbox_review_selection", { org_id: org, filter: input.filter, targets: input.targets });
  });
  it("rejects mismatched identities, missing results, reordered IDs and unavailable-name leakage", async () => {
    for (const row of [{ org_id: user }, { requester_id: org }, { access_epoch: "5" }, { items: [] }, { items: [{ ...target, id: org, status: "matching", name: "Ada" }] }, { items: [{ ...target, status: "unavailable", name: "Foreign name" }] }]) {
      await expect(fixture(row).review(input, new AbortController().signal)).rejects.toMatchObject({ status: 503 });
    }
  });
  it("rejects access revocation between classification and delivery", async () => {
    await expect(fixture({}, { ...authority, access_epoch: "5" }).review(input, new AbortController().signal)).rejects.toMatchObject({ status: 403 });
    const f = fixture();
    await expect(f.review({ ...input, orgId: user }, new AbortController().signal)).rejects.toMatchObject({ status: 403 });
    expect(f.rpc).toHaveBeenCalledTimes(1);
  });
  it("uses the exact canonical workset filter predicate on a bounded requested slice", () => {
    const canonical = readFileSync("experiments/inbox-workset-bridge/parity-v2.sql", "utf8");
    const sql = readFileSync("experiments/inbox-production-install/selection-review.sql", "utf8");
    const start = canonical.indexOf(" WHERE CASE WHEN c.target_kind");
    const predicate = canonical.slice(start, canonical.indexOf("\n$$;", start)).replace(/;$/, "").replaceAll("inbox_t2_", "inbox_");
    expect(sql.split("-- BEGIN canonical workset matching predicate\n")[1].split("\n-- END canonical workset matching predicate")[0]).toBe(predicate);
  });
});
