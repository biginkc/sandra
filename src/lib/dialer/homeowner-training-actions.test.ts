import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ client: vi.fn(), pause: vi.fn(), resume: vi.fn(), disposition: vi.fn(), appointment: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.client }));
vi.mock("@/lib/sequences/enrollment", () => ({ pausePropertyEnrollments: mocks.pause, resumeByProperty: mocks.resume }));
vi.mock("@/app/(dashboard)/messages/dispo-actions", () => ({ setOutreachDispo: mocks.disposition }));
vi.mock("@/components/appointments/book-appointment-action", () => ({ bookAppointment: mocks.appointment, getMemberTimezone: vi.fn() }));
import { prepareManualCall, completeSoftphoneCall, loadDialerRecents } from "./actions";
const operator = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const phone = "+18165550199";
const callId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const key = "k".repeat(48);
function capability(purpose = "internal_training") {
  const payload = Buffer.from(JSON.stringify({ type: "call", callId, userId: operator, phoneE164: phone, callPurpose: purpose })).toString("base64url");
  return `v1.${payload}.${createHmac("sha256", key).update(`sandra-softphone:call:${payload}`).digest("base64url")}`;
}
const input = () => ({ target: { propertyId: null, contactId: null, phoneE164: phone, maskedPhone: phone, name: "Training", address: null, state: "MO", startedAt: "2026-09-07T06:00:00Z" }, startedAt: "2026-09-07T06:00:00Z", endedAt: "2026-09-07T06:01:00Z", durationSeconds: 60, outcome: "connected_human" as const, disposition: "nurture" as const, notes: "Practice completed", wrapToken: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", callCapability: capability() });
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("HOMEOWNER_TRAINING_NUMBER", phone);
  vi.stubEnv("HOMEOWNER_TRAINING_ENABLED", "true");
  vi.stubEnv("HOMEOWNER_TRAINING_OPERATOR_IDS", operator);
  vi.stubEnv("SOFTPHONE_CAPABILITY_KEY", `v1:${key}`);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
function auth() { return { getUser: async () => ({ data: { user: { id: operator } }, error: null }) }; }
describe("real training server actions", () => {
  it("starts an unlinked training target at 1am without consulting CRM or pausing enrollments", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-07T06:00:00Z"));
    const from = vi.fn(() => { throw new Error("Must not consult CRM"); });
    mocks.client.mockResolvedValue({ auth: auth(), from });
    expect(await prepareManualCall(phone)).toMatchObject({ ok: true, data: { propertyId: null, contactId: null, name: "Internal training — AI homeowner" } });
    expect(from).not.toHaveBeenCalled(); expect(mocks.pause).not.toHaveBeenCalled();
  });
  it("a disabled reserved DID never falls back to CRM matching", async () => {
    vi.stubEnv("HOMEOWNER_TRAINING_ENABLED", "false");
    const from = vi.fn(() => { throw new Error("Must not consult CRM"); });
    mocks.client.mockResolvedValue({ auth: auth(), from });
    expect(await prepareManualCall(phone)).toMatchObject({ ok: false });
    expect(from).not.toHaveBeenCalled();
  });
  it.each(["callback", "association", "forged-purpose", "changed-number"])("rejects %s before customer side effects", async (kind) => {
    const base = input();
    const target = kind === "association" ? { ...base.target, propertyId: "seller-id" } : kind === "changed-number" ? { ...base.target, phoneE164: "+18165550198" } : base.target;
    const membership = { select: () => membership, eq: () => membership, limit: () => membership, maybeSingle: async () => ({ data: { org_id: "org" }, error: null }) };
    mocks.client.mockResolvedValue({ auth: auth(), from: () => membership });
    const result = await completeSoftphoneCall({ ...base, target, ...(kind === "callback" ? { callback: { date: "2026-09-08", time: "12:00", timeZone: "America/Chicago" } } : {}), ...(kind === "forged-purpose" ? { callCapability: capability("customer") } : {}) });
    expect(result.ok).toBe(false);
    expect(mocks.disposition).not.toHaveBeenCalled(); expect(mocks.appointment).not.toHaveBeenCalled();
  });
  it("wraps the precreated call without disposition or outreach changes", async () => {
    const update = vi.fn();
    mocks.client.mockResolvedValue({ auth: auth(), from: (table: string) => {
      let wrapLookup = false; let updating = false;
      const chain = { select: () => chain, eq: (field: string) => { if (field === "wrap_token") wrapLookup = true; return chain; }, limit: () => chain, or: () => chain,
        update: (values: unknown) => { update(values); updating = true; return chain; },
        maybeSingle: async () => ({ data: table === "memberships" ? { org_id: "org" } : updating ? { id: callId } : wrapLookup ? null : { id: callId, property_id: null, contact_id: null, operator_user_id: operator }, error: null }) };
      return chain;
    } });
    expect(await completeSoftphoneCall(input())).toMatchObject({ ok: true });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ disposition: null, do_not_call_requested: false, property_id: null, contact_id: null }));
    expect(mocks.disposition).not.toHaveBeenCalled(); expect(mocks.appointment).not.toHaveBeenCalled(); expect(mocks.resume).not.toHaveBeenCalled();
  });
  it("reads old-schema recents while training is disabled without naming the new column", async () => {
    vi.stubEnv("HOMEOWNER_TRAINING_ENABLED", "false");
    const select = vi.fn(() => chain);
    const chain = { select, eq: () => chain, order: () => chain, limit: async () => ({ data: [{ id: callId, phone_e164: phone, notes: "private provider detail" }], error: null }) };
    mocks.client.mockResolvedValue({ auth: auth(), from: () => chain });
    const result = await loadDialerRecents();
    expect(result).toMatchObject({ ok: true, data: [{ name: "Manual dial" }] });
    expect(select).toHaveBeenCalledWith(expect.stringMatching(/^\*,/));
    if (result.ok) expect(result.data[0]).not.toHaveProperty("notes");
  });
  it("labels durable training records in existing administrative recents", async () => {
    const chain = { select: () => chain, eq: () => chain, order: () => chain, limit: async () => ({ data: [{ id: callId, phone_e164: phone, call_purpose: "internal_training" }], error: null }) };
    mocks.client.mockResolvedValue({ auth: auth(), from: () => chain });
    expect(await loadDialerRecents()).toMatchObject({ ok: true, data: [{ name: "Internal training — AI homeowner" }] });
  });
});
