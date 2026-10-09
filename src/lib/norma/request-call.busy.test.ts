import { describe, expect, it, vi } from "vitest";

import { requestNormaCallCore, type RequestNormaCallDeps } from "./request-call";
import { fakeClient, PHONE } from "./test-helpers";

// RED (plan rule 3 / S2): the button shares the one capacity gate, so a dispatch that comes back `busy`
// (claim_dispatch_v2 capacity_concurrency | capacity_daily | number_busy) is a retryable, non-error result `busy_try_again`
// (not in_flight, not dispatch_rejected). The request created for it stays `requested` (refusals write nothing).
// PROPOSED: dispatchNormaCall returns { status: "busy", reason } (see dispatch.queue.test.ts).
vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

const PROPERTY_ID = "55555555-5555-4555-8555-555555555555";
const ASSIGNEE = "44444444-4444-4444-8444-444444444444";
const ENV = { NORMA_DISPATCH_ENABLED: "true", NORMA_ALLOWED_NUMBERS: PHONE, NORMA_CALLBACK_ASSIGNEE_ID: ASSIGNEE };

function run(dispatch: RequestNormaCallDeps["dispatch"]) {
  const session = fakeClient({
    properties: [{ id: PROPERTY_ID, org_id: "o1", is_training: false, homeowner_contact_id: "c1" }],
    contacts: [{ id: "c1", phone_1: PHONE, phone_2: null, phone_3: null }],
  });
  const admin = fakeClient({ norma_call_requests: [] }, {
    fn_norma_create_request: () => [{ outcome: "created", request_id: "req-1", idempotency_key: "key-1", block_reason: null }],
  });
  return requestNormaCallCore(PROPERTY_ID, null, { getUserId: async () => "user-1", sessionClient: session.client, adminClient: admin.client, env: ENV, dispatch });
}

describe("requestNormaCall — busy_try_again", () => {
  it.each(["capacity_concurrency", "capacity_daily", "number_busy"])("a dispatch refused for %s -> { ok:false, code:'busy_try_again' }", async (reason) => {
    const dispatch = vi.fn().mockResolvedValue({ status: "busy", reason } as never);
    expect(await run(dispatch)).toEqual({ ok: false, code: "busy_try_again" });
  });

  it("is distinct from in_flight (not_claimed) and from a rejection", async () => {
    expect(await run(vi.fn().mockResolvedValue({ status: "not_claimed" }))).toMatchObject({ ok: false, code: "in_flight" });
    expect(await run(vi.fn().mockResolvedValue({ status: "rejected", reason: "ineligible:dnc_locked" }))).toMatchObject({ ok: false, code: "dispatch_rejected" });
  });
});
