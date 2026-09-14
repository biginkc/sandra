import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ roster: vi.fn(), from: vi.fn(), hangup: vi.fn(), filters: [] as unknown[][] }));
vi.mock("@/lib/my-leads/queries", () => ({ getAcquisitionRoster: m.roster }));
vi.mock("./database", () => ({ createDialpadVoiceAdminClient: () => ({ from: m.from }) }));
vi.mock("./client", () => ({ DialpadVoiceClient: class { hangupCall = m.hangup; } }));
import { hangupMariaDialpadCall } from "./hangup";
const org = "11111111-1111-4111-8111-111111111111", actor = "22222222-2222-4222-8222-222222222222", intentId = "33333333-3333-4333-8333-333333333333";
let replies: unknown[];
beforeEach(() => {
  vi.resetAllMocks(); m.filters = [];
  for (const [key, value] of Object.entries({ DIALPAD_VOICE_HANGUP_ENABLED: "true", DIALPAD_VOICE_ORG_ID: org, DIALPAD_VOICE_SANDRA_USER_ID: actor, DIALPAD_VOICE_USER_ID: "4904023124647936", DIALPAD_VOICE_API_KEY: "fixture" })) vi.stubEnv(key, value);
  m.roster.mockResolvedValue({ viewer: { orgId: org, userId: actor }, roster: { settings: { enabled: false }, members: [{ id: actor, active: true, acquisitionsEnabled: false }] } });
  replies = [{ data: { provider_call_id: "123", dialpad_user_id: "4904023124647936", property_id: "lead" }, error: null }, { data: { id: "activity", provider_ended_at: null }, error: null }];
  m.from.mockImplementation(() => { const q = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn(async () => replies.shift()) }; q.select.mockReturnValue(q); q.eq.mockImplementation((...args: unknown[]) => { m.filters.push(args); return q; }); return q; });
});
afterEach(() => vi.unstubAllEnvs());
describe("Maria exact-call hangup", () => {
  it("is disabled before authentication or any provider action", async () => {
    vi.stubEnv("DIALPAD_VOICE_HANGUP_ENABLED", "false");
    expect(await hangupMariaDialpadCall({ intentId })).toMatchObject({ ok: false, error: "dialpad_hangup_disabled" });
    expect(m.roster).not.toHaveBeenCalled(); expect(m.hangup).not.toHaveBeenCalled();
  });
  it("rejects another rep before reading privileged call records", async () => {
    m.roster.mockResolvedValue({ viewer: { orgId: org, userId: intentId }, roster: { members: [] } });
    expect(await hangupMariaDialpadCall({ intentId })).toMatchObject({ ok: false, error: "forbidden" });
    expect(m.from).not.toHaveBeenCalled();
  });
  it("requires both owned intent and matching provider-confirmed activity", async () => {
    replies[1] = { data: null, error: null };
    expect(await hangupMariaDialpadCall({ intentId })).toMatchObject({ ok: false, error: "bound_call_required" });
    expect(m.filters).toEqual(expect.arrayContaining([["id", intentId], ["org_id", org], ["actor_user_id", actor], ["operator_user_id", actor], ["property_id", "lead"], ["provider", "dialpad"], ["provider_call_id", "123"]]));
    expect(m.hangup).not.toHaveBeenCalled();
  });
  it("never substitutes an unbound intent or another provider user", async () => {
    for (const patch of [{ provider_call_id: null }, { dialpad_user_id: "other" }]) {
      replies = [{ data: { provider_call_id: "123", dialpad_user_id: "4904023124647936", ...patch }, error: null }];
      expect(await hangupMariaDialpadCall({ intentId })).toMatchObject({ ok: false, error: "bound_call_required" });
    }
    expect(m.hangup).not.toHaveBeenCalled();
  });
  it("allows stopping an existing owned call when new acquisitions are disabled, without claiming termination", async () => {
    expect(await hangupMariaDialpadCall({ intentId })).toEqual({ ok: true, status: "hangup_requested" });
    expect(m.hangup).toHaveBeenCalledExactlyOnceWith("123");
  });
  it("does not call the provider again when terminal evidence already exists", async () => {
    replies[1] = { data: { id: "activity", provider_ended_at: "2026-09-13T00:00:00Z" }, error: null };
    expect(await hangupMariaDialpadCall({ intentId })).toEqual({ ok: true, status: "already_ended" });
    expect(m.hangup).not.toHaveBeenCalled();
  });
  it("leaves a lost provider response unconfirmed and never retries", async () => {
    m.hangup.mockRejectedValue(new Error("private provider response"));
    expect(await hangupMariaDialpadCall({ intentId })).toEqual({ ok: true, status: "hangup_unconfirmed" });
    expect(m.hangup).toHaveBeenCalledOnce();
  });
});
