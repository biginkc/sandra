import { describe, expect, it, vi } from "vitest";

import { requestNormaCallCore, type RequestNormaCallDeps } from "./request-call";
import { fakeClient, PHONE } from "./test-helpers";

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

const ASSIGNEE = "44444444-4444-4444-8444-444444444444";
const ENV = { NORMA_DISPATCH_ENABLED: "true", NORMA_ALLOWED_NUMBERS: PHONE, NORMA_CALLBACK_ASSIGNEE_ID: ASSIGNEE };

function setup(opts: {
  userId?: string | null; env?: Record<string, string>; property?: Record<string, unknown> | null;
  contact?: Record<string, unknown>; create?: Record<string, unknown>; wrong?: string[];
  dispatch?: RequestNormaCallDeps["dispatch"];
} = {}) {
  const createRpc = vi.fn().mockReturnValue([opts.create ?? { outcome: "created", request_id: "req-1", idempotency_key: "key-1", block_reason: null }]);
  const session = fakeClient({
    properties: opts.property === null ? [] : [{ id: "p1", org_id: "o1", is_training: false, homeowner_contact_id: "c1", ...opts.property }],
    contacts: [{ id: "c1", phone_1: PHONE, phone_2: null, phone_3: null, ...opts.contact }],
  });
  const admin = fakeClient(
    { norma_call_requests: (opts.wrong ?? []).map((phone_e164) => ({ phone_e164, org_id: "o1", status: "completed", outcome: "wrong_number" })) },
    { fn_norma_create_request: createRpc },
  );
  const dispatch = opts.dispatch ?? vi.fn().mockResolvedValue({ status: "dispatched", callId: "c" });
  const run = () =>
    requestNormaCallCore("p1", " hello ", {
      getUserId: async () => (opts.userId === undefined ? "user-1" : opts.userId),
      sessionClient: session.client,
      adminClient: admin.client,
      env: opts.env ?? ENV,
      dispatch,
    });
  return { run, createRpc, dispatch };
}

describe("requestNormaCall result codes", () => {
  it("unauthenticated", async () => {
    const t = setup({ userId: null });
    expect(await t.run()).toEqual({ ok: false, code: "unauthenticated" });
    expect(t.createRpc).not.toHaveBeenCalled();
  });

  it("fails clearly when the callback assignee is unset or malformed", async () => {
    for (const bad of [undefined, "not-a-uuid"]) {
      const env = { ...ENV, NORMA_CALLBACK_ASSIGNEE_ID: bad as string };
      if (bad === undefined) delete (env as Record<string, unknown>).NORMA_CALLBACK_ASSIGNEE_ID;
      const t = setup({ env });
      expect(await t.run()).toEqual({ ok: false, code: "callback_assignee_not_configured" });
      expect(t.createRpc).not.toHaveBeenCalled();
    }
  });

  it("lead not found / invisible to the session", async () => {
    expect(await setup({ property: null }).run()).toEqual({ ok: false, code: "lead_not_found" });
  });

  it("training lead is refused before any request", async () => {
    const t = setup({ property: { is_training: true } });
    expect(await t.run()).toEqual({ ok: false, code: "training_lead" });
    expect(t.createRpc).not.toHaveBeenCalled();
  });

  it("no callable number (non-US, or flagged wrong via Norma)", async () => {
    expect(await setup({ contact: { phone_1: "+442079460958" } }).run()).toEqual({ ok: false, code: "no_callable_number" });
    expect(await setup({ wrong: [PHONE] }).run()).toEqual({ ok: false, code: "no_callable_number" });
  });

  it("gate off: no request created, no pause, no dispatch", async () => {
    const t = setup({ env: { ...ENV, NORMA_DISPATCH_ENABLED: "false" } });
    expect(await t.run()).toEqual({ ok: false, code: "gate_off", reason: "dispatch_disabled" });
    expect(t.createRpc).not.toHaveBeenCalled();
    expect(t.dispatch).not.toHaveBeenCalled();
  });

  it("non-allowlisted number: refused without creating a request", async () => {
    const t = setup({ env: { ...ENV, NORMA_ALLOWED_NUMBERS: "+18165550000" } });
    expect(await t.run()).toEqual({ ok: false, code: "gate_off", reason: "number_not_allowed" });
    expect(t.createRpc).not.toHaveBeenCalled();
  });

  it("blocked reasons are passed through", async () => {
    const t = setup({ create: { outcome: "blocked", block_reason: "global_dnc_registry" } });
    expect(await t.run()).toEqual({ ok: false, code: "blocked", reason: "global_dnc_registry" });
    expect(t.dispatch).not.toHaveBeenCalled();
  });

  it("a training block from the RPC maps to training_lead", async () => {
    expect(await setup({ create: { outcome: "blocked", block_reason: "training_lead" } }).run()).toEqual({ ok: false, code: "training_lead" });
  });

  it("already open: in flight, no dispatch", async () => {
    const t = setup({ create: { outcome: "already_open", request_id: "req-9" } });
    expect(await t.run()).toEqual({ ok: false, code: "in_flight", requestId: "req-9" });
    expect(t.dispatch).not.toHaveBeenCalled();
  });

  it("created and dispatched -> calling; trims the context and passes the assignee", async () => {
    const t = setup();
    expect(await t.run()).toEqual({ ok: true, code: "calling", requestId: "req-1" });
    expect(t.createRpc).toHaveBeenCalledWith(expect.objectContaining({
      p_phone_e164: PHONE, p_requested_by: "user-1", p_rep_context: "hello", p_callback_assignee_id: ASSIGNEE,
    }));
    expect(t.dispatch).toHaveBeenCalledWith("req-1");
  });

  it("dispatch outcomes: unknown, rejected, thrown", async () => {
    expect(await setup({ dispatch: async () => ({ status: "unknown", reason: "timeout" }) }).run()).toEqual({ ok: true, code: "dispatch_unknown", requestId: "req-1" });
    expect(await setup({ dispatch: async () => ({ status: "rejected", reason: "bland_402" }) }).run()).toEqual({ ok: false, code: "dispatch_rejected", reason: "bland_402", requestId: "req-1" });
    expect(await setup({ dispatch: async () => { throw new Error("boom"); } }).run()).toEqual({ ok: true, code: "dispatch_unknown", requestId: "req-1" });
  });
});
