import { describe, expect, it, vi } from "vitest";

import { describeRequestResult, normaBlockText } from "./block-copy";
import { previewNormaCallCore } from "./preview";
import { fakeClient, PHONE } from "./test-helpers";

const PROPERTY_ID = "55555555-5555-4555-8555-555555555555";
const ASSIGNEE = "44444444-4444-4444-8444-444444444444";
const ENV = { NORMA_DISPATCH_ENABLED: "true", NORMA_ALLOWED_NUMBERS: PHONE, NORMA_CALLBACK_ASSIGNEE_ID: ASSIGNEE };

function setup(opts: {
  userId?: string | null; env?: Record<string, string>; property?: Record<string, unknown> | null;
  contact?: Record<string, unknown>; open?: boolean; eligibility?: Record<string, unknown>; wrong?: string[];
} = {}) {
  const eligibility = vi.fn().mockReturnValue([opts.eligibility ?? { eligible: true, block_reason: null }]);
  const session = fakeClient({
    properties: opts.property === null ? [] : [{ id: PROPERTY_ID, org_id: "o1", is_training: false, homeowner_contact_id: "c1", ...opts.property }],
    contacts: [{ id: "c1", phone_1: PHONE, phone_2: null, phone_3: null, ...opts.contact }],
    norma_call_requests: opts.open ? [{ property_id: PROPERTY_ID, status: "dispatched", id: "r1" }] : [],
  });
  const admin = fakeClient(
    { norma_call_requests: (opts.wrong ?? []).map((phone_e164) => ({ phone_e164, org_id: "o1", status: "completed", outcome: "wrong_number" })) },
    { fn_norma_eligibility: eligibility },
  );
  const run = () =>
    previewNormaCallCore(PROPERTY_ID, {
      getUserId: async () => (opts.userId === undefined ? "user-1" : opts.userId),
      sessionClient: session.client, adminClient: admin.client, env: opts.env ?? ENV,
    });
  return { run, admin, eligibility };
}

describe("previewNormaCallCore", () => {
  it("reports the number that would be dialled when nothing blocks", async () => {
    expect(await setup().run()).toEqual({ callable: true, phoneE164: PHONE });
  });

  it("maps each block to a result code", async () => {
    expect(await setup({ userId: null }).run()).toMatchObject({ callable: false, block: { code: "unauthenticated" } });
    expect(await setup({ property: null }).run()).toMatchObject({ block: { code: "lead_not_found" } });
    expect(await setup({ property: { is_training: true } }).run()).toMatchObject({ block: { code: "training_lead" } });
    expect(await setup({ open: true }).run()).toMatchObject({ block: { code: "in_flight" } });
    expect(await setup({ contact: { phone_1: null } }).run()).toMatchObject({ block: { code: "no_callable_number" } });
    expect(await setup({ wrong: [PHONE] }).run()).toMatchObject({ block: { code: "no_callable_number" } });
    expect(await setup({ env: { ...ENV, NORMA_DISPATCH_ENABLED: "false" } }).run()).toMatchObject({ block: { code: "gate_off", reason: "dispatch_disabled" }, phoneE164: PHONE });
    expect(await setup({ env: { ...ENV, NORMA_ALLOWED_NUMBERS: "+18165550999" } }).run()).toMatchObject({ block: { code: "gate_off", reason: "number_not_allowed" } });
    expect(await setup({ env: { ...ENV, NORMA_CALLBACK_ASSIGNEE_ID: "" } }).run()).toMatchObject({ block: { code: "callback_assignee_not_configured" } });
  });

  it("surfaces eligibility blocks with their reason, and fails closed on a check error", async () => {
    for (const reason of ["dnc_locked", "global_dnc_registry", "not_interested"]) {
      expect(await setup({ eligibility: { eligible: false, block_reason: reason } }).run()).toMatchObject({ block: { code: "blocked", reason } });
    }
    expect(await setup({ eligibility: { eligible: false, block_reason: null } }).run()).toMatchObject({ block: { code: "blocked", reason: "eligibility_check_failed" } });
  });

  it("never writes anything", async () => {
    const t = setup();
    await t.run();
    expect(t.admin.calls.map((c) => c.name)).toEqual(["fn_norma_eligibility"]);
    expect(t.admin.updates).toEqual([]);
  });
});

describe("block copy", () => {
  it("gives every block a plain, non-empty reason", () => {
    for (const reason of ["dnc_locked", "dnc_contact", "global_dnc_registry", "not_interested", "wrong_number_flagged", "totally_new_code"]) {
      expect(normaBlockText({ code: "blocked", reason }).length).toBeGreaterThan(10);
    }
    expect(normaBlockText({ code: "blocked", reason: "totally_new_code" })).not.toContain("totally_new_code");
    expect(normaBlockText({ code: "gate_off", reason: "dispatch_disabled" })).toMatch(/switched off/);
    expect(normaBlockText({ code: "gate_off", reason: "number_not_allowed" })).toMatch(/test numbers/);
  });

  it("describes request results, warning on an uncertain send", () => {
    expect(describeRequestResult({ ok: true, code: "calling", requestId: "r" }).tone).toBe("success");
    expect(describeRequestResult({ ok: true, code: "dispatch_unknown", requestId: "r" }).tone).toBe("warning");
    expect(describeRequestResult({ ok: false, code: "in_flight", requestId: null }).tone).toBe("warning");
    expect(describeRequestResult({ ok: false, code: "blocked", reason: "dnc_locked" })).toMatchObject({ tone: "error", text: expect.stringContaining("do-not-contact") });
  });
});
