// Acceptance cases (.planning/direct-calling ACCEPTANCE: A*, UD*, E*, B*, C*, D*) run end to end:
// the real service + webhook processor + cleanup module against an in-memory store and a fake provider.
import { describe, expect, it, vi } from "vitest";

import { processDueCleanups, RESOLVED_BY_TIME_LIMIT, type CleanupDeps } from "./cleanup";
import type { DirectCallTarget } from "./contract";
import { createDirectCallService } from "./service";
import { TelnyxApiError, encodeClientState, type ActiveCall, type DialParams } from "./telnyx";
import { FakeStore } from "./test-support";
import { processDirectCallWebhook, type WebhookDeps } from "./webhook";

const T0 = new Date("2026-10-01T12:00:00.000Z");
const ENV = {
  DIRECT_CALL_PILOT_USER_IDS: "user-1,user-2",
  TELNYX_DIRECT_API_KEY: "SECRET-KEY-123",
  TELNYX_DIRECT_CONNECTION_ID: "conn",
  TELNYX_DIRECT_APP_ID: "app",
  TELNYX_DIRECT_WEBHOOK_PUBLIC_KEY: "pub",
  DIRECT_CALL_CALLER_ID_E164: "+15550002222",
  DIRECT_CALL_CONTAINMENT_VERIFIED: "true",
};
const req = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ENDED_422 = () => new TelnyxApiError("Telnyx returned 422: Call has already ended", "rejected", 422, { code: "90018" });
const DOWN = () => new TelnyxApiError("Telnyx returned 503", "unknown", 503);

type Leg = { alive: boolean; clientState: Record<string, unknown> | null };

function world(opts: { lead?: boolean; timeLimitSecs?: number } = {}) {
  const clock = { now: T0 };
  const store = new FakeStore();
  store.clock = () => clock.now;
  const legs = new Map<string, Leg>();
  const p = {
    outage: false,
    listOutage: false,
    dialMode: "ok" as "ok" | "reject" | "http5xx" | "timeout_ghost" | "timeout_noleg" | "hang",
    hangupMode: "ack" as "ack" | "end",
    hangupError: null as Error | null,
    n: 0,
    counts: { dial: 0, hangup: 0, get: 0, list: 0 },
    hangupIds: [] as string[],
    dialParams: [] as DialParams[],
  };
  const resumes: Array<{ via: string; propertyId: string }> = [];
  const dial = async (params: DialParams) => {
    p.counts.dial += 1;
    p.dialParams.push(params);
    if (p.dialMode === "reject") throw new TelnyxApiError("Telnyx returned 422", "rejected", 422);
    if (p.dialMode === "http5xx") throw new TelnyxApiError("Telnyx returned 503", "unknown", 503);
    if (p.dialMode === "hang") return new Promise<{ callControlId: string }>(() => undefined);
    const id = `LEG-${++p.n}`;
    if (p.dialMode === "timeout_noleg") throw new TelnyxApiError("Telnyx request timed out.", "unknown", null);
    legs.set(id, { alive: true, clientState: params.clientState });
    if (p.dialMode === "timeout_ghost") throw new TelnyxApiError("Telnyx request timed out.", "unknown", null);
    return { callControlId: id };
  };
  const hangup = async (leg: string, commandId: string) => {
    p.counts.hangup += 1;
    p.hangupIds.push(commandId);
    if (p.outage) throw DOWN();
    if (p.hangupError) throw p.hangupError;
    const l = legs.get(leg);
    if (!l || !l.alive) throw ENDED_422();
    if (p.hangupMode === "end") l.alive = false;
  };
  const getCall = async (leg: string) => {
    p.counts.get += 1;
    if (p.outage) throw DOWN();
    const l = legs.get(leg);
    if (!l) throw new TelnyxApiError("Telnyx returned 422", "rejected", 422);
    return { isAlive: l.alive };
  };
  const listActiveCalls = async (): Promise<{ calls: ActiveCall[]; complete: boolean }> => {
    p.counts.list += 1;
    if (p.outage || p.listOutage) throw DOWN();
    return { calls: [...legs.entries()].filter(([, l]) => l.alive).map(([id, l]) => ({ callControlId: id, clientState: l.clientState })), complete: true };
  };
  const report = vi.fn();
  const env = { ...ENV, ...(opts.timeLimitSecs ? { DIRECT_CALL_TIME_LIMIT_SECS: String(opts.timeLimitSecs) } : {}) };
  const prepare = vi.fn();
  const targetFor = (propertyId: string | null, phone = "+15550009999"): DirectCallTarget => ({
    propertyId, contactId: propertyId ? "contact-1" : null, phoneE164: phone, maskedPhone: "(555) 000-9999", name: "Seller", address: null, state: null, startedAt: T0.toISOString(),
  });
  const service = createDirectCallService({
    store, env, now: () => clock.now,
    prepareLeadCall: async (propertyId) => { prepare(propertyId); return { ok: true, data: targetFor(opts.lead === false ? null : propertyId) }; },
    prepareManualCall: async (phone) => { prepare(phone); return { ok: true, data: targetFor(null, phone === "training" ? "+15550007777" : "+15550009999") }; },
    resumeFailedSoftphoneCall: async (propertyId) => { resumes.push({ via: "service", propertyId }); },
    sealCallIdentity: ({ callId }) => ({ capability: `sealed:${callId}`, training: false }),
    telnyx: {
      dial: (_s, params) => dial(params), hangup: (_s, leg, cmd) => hangup(leg, cmd), getCall: (_s, leg) => getCall(leg),
      listActiveCalls: () => listActiveCalls(), sendDtmf: async () => undefined,
      createCredential: async () => ({ id: "cred", sipUsername: "gencred" }), createToken: async () => "jwt",
    },
    report,
  });
  const whDeps: WebhookDeps = {
    store, dial, hangup, getCall, listActiveCalls, now: () => clock.now, report,
  };
  const cleanupDeps: CleanupDeps = { store, hangup, getCall, listActiveCalls, now: () => clock.now, report, random: () => 0 };
  let evt = 0;
  const hook = (type: string, leg: string | null, role: "browser" | "seller", callId: string, extra: Record<string, unknown> = {}, id?: string) =>
    processDirectCallWebhook(
      JSON.stringify({ data: { id: id ?? `evt-${++evt}`, event_type: type, occurred_at: clock.now.toISOString(), payload: { call_control_id: leg, client_state: encodeClientState({ directCallId: callId, role }), ...extra } } }),
      whDeps,
    );
  const advance = (secs: number) => { clock.now = new Date(clock.now.getTime() + secs * 1000); };
  const start = (n: number, input: Record<string, unknown> = { kind: "manual", phone: "5550009999" }, user = "user-1") =>
    service.startCall(user, { ...input, clientRequestId: req(n) } as never);
  const provider = (leg: string) => legs.get(leg)!;
  /** The operator's own session polling: the only place a resume can run. */
  const poll = (callId: string, user = "user-1") => service.getStatus(user, callId);
  const open = () => [...store.cleanups.values()].filter((c) => !c.confirmed_at);
  return { clock, store, legs, p, env, resumes, service, whDeps, cleanupDeps, hook, advance, start, poll, provider, open, report, prepare };
}

async function startedCall(w: ReturnType<typeof world>, n = 1, input?: Record<string, unknown>, user = "user-1") {
  const r = await w.start(n, input, user);
  if (!r.ok) throw new Error(`setup failed: ${JSON.stringify(r)}`);
  return r.data;
}

describe("acceptance: telephony", () => {
  it("freezes a bounded pilot limit across both Dials even if configuration changes mid-call", async () => {
    const w = world({ timeLimitSecs: 30 });
    const call = await startedCall(w);
    expect(w.p.dialParams[0]).toMatchObject({ timeLimitSecs: 30, retryOnTimeout: false });
    expect(w.store.calls.get(call.directCallId)?.time_limit_secs).toBe(30);
    // Attempt both an expansion and an unset configuration after reservation; neither can widen this call.
    w.env.DIRECT_CALL_TIME_LIMIT_SECS = "180";
    w.env.DIRECT_CALL_TIME_LIMIT_SECS = undefined;
    w.p.dialMode = "timeout_noleg";
    await w.hook("call.answered", call.browserLegId, "browser", call.directCallId);
    expect(w.p.dialParams[1]).toMatchObject({ timeLimitSecs: 30, retryOnTimeout: false });
    expect(w.p.dialParams.every((params) => params.timeLimitSecs <= 30)).toBe(true);
    const sellerCleanup = w.open().find((c) => c.kind === "unresolved_dial" && c.dial_role === "seller")!;
    expect(new Date(sellerCleanup.backstop_at!).getTime() - w.clock.now.getTime()).toBe(30_000 + 30_000 + 10_000 + 60_000);
  });

  it("cancellation during a browser Dial keeps the dispatch obligation and never re-Dials", async () => {
    const w = world({ timeLimitSecs: 180 });
    w.p.dialMode = "hang";
    void w.start(1);
    await vi.waitFor(() => expect(w.p.counts.dial).toBe(1));
    expect(await w.service.cancelByRequest("user-1", req(1))).toMatchObject({ ok: true, data: { tombstoned: false } });
    expect(w.store.calls.get([...w.store.calls.keys()][0])).toMatchObject({ status: "ending", browser_dial_started_at: expect.any(String) });
    expect(w.open().map((c) => `${c.kind}:${c.dial_role}`)).toEqual(["unresolved_dial:browser"]);
    expect(w.p.counts.dial).toBe(1);
    expect((await w.start(2)).ok).toBe(false);
  });

  it("A1 normal call: both legs' hangup webhooks leave zero unconfirmed rows and the operator free", async () => {
    const w = world();
    const call = await startedCall(w);
    await w.hook("call.answered", call.browserLegId, "browser", call.directCallId);
    const seller = w.store.calls.get(call.directCallId)!.seller_leg_id!;
    await w.hook("call.answered", seller, "seller", call.directCallId);
    expect(w.store.calls.get(call.directCallId)?.status).toBe("connected");
    w.provider(seller).alive = false;
    await w.hook("call.hangup", seller, "seller", call.directCallId);
    expect(w.store.calls.get(call.directCallId)?.status).toBe("ended");
    expect(w.open().map((c) => c.leg_id)).toEqual([call.browserLegId]); // hung up (2xx), awaiting its own webhook
    w.provider(call.browserLegId).alive = false;
    await w.hook("call.hangup", call.browserLegId, "browser", call.directCallId);
    expect(w.open()).toEqual([]);
    expect(await w.store.operatorBusy("user-1")).toBeNull();
    expect((await w.start(2)).ok).toBe(true);
  });

  it("A2 browser Dial 4xx: nothing live, unresolved row resolved, lead resumed once, second start admitted", async () => {
    const w = world();
    w.p.dialMode = "reject";
    expect(await w.start(1, { kind: "lead", propertyId: "prop-1" })).toMatchObject({ ok: false, errorCode: "start_failed" });
    expect(w.open()).toEqual([]);
    expect(w.resumes).toEqual([{ via: "service", propertyId: "prop-1" }]);
    w.p.dialMode = "ok";
    expect((await w.start(2, { kind: "lead", propertyId: "prop-1" })).ok).toBe(true);
  });

  it("A3 browser Dial timeout: the unresolved row persists; a later webhook with our client_state is hung up; Dial count stays 1", async () => {
    const w = world();
    w.p.dialMode = "timeout_ghost";
    expect(await w.start(1)).toMatchObject({ ok: false });
    const row = [...w.store.calls.values()][0];
    expect(w.open().map((c) => `${c.kind}:${c.dial_role}`)).toEqual(["unresolved_dial:browser"]);
    expect(await w.store.operatorBusy("user-1")).toBe("cleanup");
    await w.hook("call.initiated", "LEG-1", "browser", row.id);
    expect(w.p.counts.hangup).toBeGreaterThanOrEqual(1);
    expect(w.store.legRow("LEG-1")).toBeDefined();
    expect(w.p.counts.dial).toBe(1);
  });

  it("A4 crash after the Dial was sent and before the leg was stored: the unresolved row already exists and the operator is busy", async () => {
    const w = world();
    w.p.dialMode = "hang";
    void w.start(1);
    await vi.waitFor(() => expect(w.p.counts.dial).toBe(1));
    expect(w.open().map((c) => `${c.kind}:${c.dial_role}`)).toEqual(["unresolved_dial:browser"]);
    expect(await w.store.operatorBusy("user-1")).toBe("call");
    expect((await w.start(2)).ok).toBe(false);
  });

  it("A11 hangup refusals: 422/90018 confirms; another 422 or a 404 stays pending until a status check agrees", async () => {
    for (const [error, confirmed] of [[ENDED_422(), true], [new TelnyxApiError("x", "rejected", 422, { code: "90001" }), false], [new TelnyxApiError("x", "rejected", 404), false]] as const) {
      const w = world();
      const call = await startedCall(w);
      w.p.hangupError = error;
      await w.service.control("user-1", call.directCallId, { action: "hangup" });
      expect(w.store.legRow(call.browserLegId)?.confirmed_at !== null).toBe(confirmed);
      if (confirmed) continue;
      expect(await w.store.operatorBusy("user-1")).toBe("call");
      // Hangup keeps being refused: still pending, and no status check yet (it rides every 4th failed attempt).
      w.provider(call.browserLegId).alive = false;
      w.p.hangupError = new TelnyxApiError("x", "rejected", 404);
      for (let attempt = 2; attempt <= 3; attempt += 1) {
        w.advance(120);
        await w.service.getStatus("user-1", call.directCallId);
        expect(w.store.legRow(call.browserLegId)?.confirmed_at ?? null).toBeNull();
      }
      // The 4th failed attempt also asks the provider: is_alive:false confirms (hangup is still refusing).
      w.advance(120);
      await w.service.getStatus("user-1", call.directCallId);
      expect(w.store.legRow(call.browserLegId)?.confirmed_at).toBeTruthy();
    }
  });

  it("A12 hangup 2xx with no webhook: no re-check before 10s; then GET alive re-sends with a fresh command id, GET dead confirms", async () => {
    const w = world();
    const call = await startedCall(w);
    await w.service.control("user-1", call.directCallId, { action: "hangup" });
    expect(w.p.counts).toMatchObject({ hangup: 1, get: 0 });
    w.advance(6);
    await w.service.getStatus("user-1", call.directCallId);
    expect(w.p.counts).toMatchObject({ hangup: 1, get: 0 }); // < 10s: nothing
    w.advance(5); // 11s
    await w.service.getStatus("user-1", call.directCallId);
    expect(w.p.counts).toMatchObject({ hangup: 2, get: 1 }); // alive -> re-sent
    expect(new Set(w.p.hangupIds).size).toBe(2);
    w.provider(call.browserLegId).alive = false;
    w.advance(30);
    await w.service.getStatus("user-1", call.directCallId);
    expect(w.store.legRow(call.browserLegId)?.confirmed_at).not.toBeNull();
  });

  it("A13 provider failing for 600s then recovering: rows are never dropped and are confirmed after recovery", async () => {
    const w = world();
    const call = await startedCall(w);
    w.p.outage = true;
    await w.service.control("user-1", call.directCallId, { action: "hangup" });
    for (let t = 0; t < 600; t += 1) {
      w.advance(1);
      await w.service.getStatus("user-1", call.directCallId);
    }
    expect(w.open().length).toBe(1);
    expect(await w.store.operatorBusy("user-1")).toBe("call");
    w.p.outage = false;
    w.p.hangupMode = "end";
    for (let t = 0; t < 120 && w.open().length > 0; t += 1) {
      w.advance(1);
      await w.service.getStatus("user-1", call.directCallId);
    }
    w.advance(120);
    await w.hook("call.hangup", call.browserLegId, "browser", call.directCallId);
    expect(w.open()).toEqual([]);
  });

  it("E1/E2 600s outage, two tabs polling at 1s, three redeliveries per event: <=16 provider requests per row, cleanupPending stays true", async () => {
    const w = world();
    const call = await startedCall(w);
    w.store.calls.set(call.directCallId, { ...w.store.calls.get(call.directCallId)!, status: "ended" });
    w.store.addCleanup({ direct_call_id: call.directCallId, kind: "leg", leg_id: call.browserLegId });
    w.p.outage = true;
    const rowsAtStart = w.open().length;
    for (let t = 0; t < 600; t += 1) {
      w.advance(1);
      const [a, b] = await Promise.all([w.service.getStatus("user-1", call.directCallId), w.service.getStatus("user-1", call.directCallId)]);
      expect(a).toMatchObject({ ok: true, data: { cleanupPending: true } });
      expect(b).toMatchObject({ ok: true, data: { cleanupPending: true } });
      if (t % 30 === 0) for (let k = 0; k < 3; k += 1) await w.hook("call.bridged", call.browserLegId, "browser", call.directCallId, {}, `redeliver-${t}`);
    }
    const requests = w.p.counts.hangup + w.p.counts.get + w.p.counts.list;
    expect(requests / rowsAtStart).toBeLessThanOrEqual(16);
    expect(w.open().length).toBe(rowsAtStart);
  });

  it("C2 a three-hour-old unconfirmed row whose leg is still alive keeps the operator busy and re-sends the hangup", async () => {
    const w = world();
    const call = await startedCall(w);
    w.store.calls.set(call.directCallId, { ...w.store.calls.get(call.directCallId)!, status: "ended" });
    const row = w.store.addCleanup({ direct_call_id: call.directCallId, kind: "leg", leg_id: call.browserLegId, acked_at: T0.toISOString(), attempts: 7 });
    w.advance(3 * 3600);
    row.next_attempt_at = w.clock.now.toISOString();
    const before = w.p.counts.hangup;
    await w.service.getStatus("user-1", call.directCallId);
    expect(w.p.counts.hangup).toBe(before + 1);
    expect(await w.store.operatorBusy("user-1")).toBe("cleanup");
  });
});

describe("acceptance: unresolved Dial reconciliation", () => {
  async function unresolvedWorld() {
    const w = world();
    w.p.dialMode = "timeout_ghost";
    await w.start(1); // browser Dial times out; the provider did create LEG-1
    const dialRow = w.open().find((c) => c.kind === "unresolved_dial")!;
    return { w, dialRow };
  }

  it("UD1 an active-calls match by client_state becomes a leg row and is hung up", async () => {
    const { w, dialRow } = await unresolvedWorld();
    w.advance(56);
    await processDueCleanups(w.cleanupDeps, "user-1");
    expect(w.store.legRow("LEG-1")).toBeDefined();
    expect(w.p.counts.hangup).toBe(1);
    expect(w.store.cleanups.get(dialRow.id)?.confirmed_at).not.toBeNull();
    // The leg is still unconfirmed, so the operator stays locked until it is.
    expect(await w.store.operatorBusy("user-1")).toBe("cleanup");
  });

  it("UD2 two empty listings before timeout+allowance+15s still leave the Dial unresolved; two after resolve it", async () => {
    const w = world();
    w.p.dialMode = "timeout_noleg";
    await w.start(1);
    const dialRow = w.open().find((c) => c.kind === "unresolved_dial")!;
    for (let i = 0; i < 2; i += 1) {
      dialRow.next_attempt_at = w.clock.now.toISOString();
      w.advance(10); // 10s, 20s: both before 30+10+15
      await processDueCleanups(w.cleanupDeps, "user-1");
    }
    expect(w.store.cleanups.get(dialRow.id)).toMatchObject({ confirmed_at: null, empty_matches: 0 });
    for (let i = 0; i < 2; i += 1) {
      w.advance(60);
      await processDueCleanups(w.cleanupDeps, "user-1");
    }
    expect(w.store.cleanups.get(dialRow.id)?.confirmed_at).not.toBeNull();
    expect(await w.store.operatorBusy("user-1")).toBeNull();
  });

  it("UD3 with no listing possible the Dial is resolved only at attempt + allowance + time_limit + 60s, and that is logged", async () => {
    const w = world();
    w.p.dialMode = "timeout_noleg";
    await w.start(1);
    const dialRow = w.open().find((c) => c.kind === "unresolved_dial")!;
    w.p.listOutage = true;
    for (let t = 0; t < 7200; t += 60) {
      w.advance(60);
      await processDueCleanups(w.cleanupDeps, "user-1");
    }
    expect(w.store.cleanups.get(dialRow.id)?.confirmed_at).toBeNull();
    w.advance(120);
    await processDueCleanups(w.cleanupDeps, "user-1");
    expect(w.store.cleanups.get(dialRow.id)).toMatchObject({ confirmed_at: expect.any(String), last_error: RESOLVED_BY_TIME_LIMIT });
    expect(w.report).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining(RESOLVED_BY_TIME_LIMIT) }), "direct_call_dial_backstop");
  });
});

describe("acceptance: browser and lock", () => {
  it("B2 cancel(id) then start(id) dials nothing and prepares nothing", async () => {
    const w = world();
    expect(await w.service.cancelByRequest("user-1", req(1))).toEqual({ ok: true, data: { directCallId: null, tombstoned: true } });
    expect(await w.start(1)).toMatchObject({ ok: false, errorCode: "cancelled" });
    expect(w.p.counts.dial).toBe(0);
    expect(w.prepare).not.toHaveBeenCalled();
    expect(await w.service.getStatusByRequest("user-1", req(1))).toMatchObject({ ok: true, data: { status: "failed", failureReason: "cancelled_before_start", cleanupPending: false } });
    expect(await w.store.operatorBusy("user-1")).toBeNull();
  });

  it("B2 start(id) then cancel(id) ends the call and cleans its rows", async () => {
    const w = world();
    const call = await startedCall(w);
    expect(await w.service.cancelByRequest("user-1", req(1))).toMatchObject({ ok: true, data: { directCallId: call.directCallId, tombstoned: false } });
    expect(w.p.counts.hangup).toBe(1);
    w.provider(call.browserLegId).alive = false;
    await w.hook("call.hangup", call.browserLegId, "browser", call.directCallId);
    expect(w.store.calls.get(call.directCallId)?.status).toBe("ended");
    expect(w.open()).toEqual([]);
    expect(await w.service.getStatusByRequest("user-1", req(1))).toMatchObject({ ok: true, data: { status: "ended", cleanupPending: false } });
  });

  it("B2 a cancel that lands between reserve and Dial wins: nothing is dialed", async () => {
    const w = world();
    const original = w.store.setTarget.bind(w.store);
    w.store.setTarget = async (id, target) => {
      const stored = await original(id, target);
      await w.service.cancelByRequest("user-1", req(1)); // the browser gave up while prepare was running
      return stored;
    };
    expect(await w.start(1, { kind: "lead", propertyId: "prop-1" })).toMatchObject({ ok: false, errorCode: "cancelled" });
    expect(w.p.counts.dial).toBe(0);
  });

  it("B4 two tabs, different request ids, concurrent: exactly one Dial and one prepare; the other is call_in_progress", async () => {
    const w = world();
    const [a, b] = await Promise.all([w.start(1), w.start(2)]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    const loser = a.ok ? b : a;
    expect(loser).toMatchObject({ ok: false, errorCode: "call_in_progress" });
    expect(w.p.counts.dial).toBe(1);
    expect(w.prepare).toHaveBeenCalledTimes(1);
  });
});

describe("acceptance: lead pause ownership", () => {
  it("D2 every browser Dial failure after server prepare resumes the lead exactly once (4xx, 5xx, timeout)", async () => {
    for (const mode of ["reject", "http5xx", "timeout_noleg"] as const) {
      const w = world();
      w.p.dialMode = mode;
      expect(await w.start(1, { kind: "lead", propertyId: "prop-1" })).toMatchObject({ ok: false, errorCode: "start_failed" });
      expect(w.resumes).toEqual([{ via: "service", propertyId: "prop-1" }]);
    }
  });

  it("D3 the seller never connects and the call fails by webhook: nothing resumes in the webhook; the operator's next poll resumes once", async () => {
    const w = world();
    const call = await startedCall(w, 1, { kind: "lead", propertyId: "prop-1" });
    await w.hook("call.answered", call.browserLegId, "browser", call.directCallId);
    const seller = w.store.calls.get(call.directCallId)!.seller_leg_id!;
    w.provider(seller).alive = false;
    await w.hook("call.hangup", seller, "seller", call.directCallId, { hangup_cause: "no_answer" });
    expect(w.store.calls.get(call.directCallId)).toMatchObject({ status: "failed", failure_reason: "seller_not_answered", resume_pending: true });
    expect(w.resumes).toEqual([]); // the webhook has no operator session: it only records the obligation
    await w.poll(call.directCallId);
    expect(w.resumes).toEqual([{ via: "service", propertyId: "prop-1" }]);
    expect(w.store.calls.get(call.directCallId)?.resume_pending).toBe(false);
    // A redelivered hangup, and more polls, do not resume again.
    await w.hook("call.hangup", seller, "seller", call.directCallId, {}, "again");
    await w.poll(call.directCallId);
    expect(w.resumes).toHaveLength(1);
  });

  it("D3 an unknown seller Dial also resumes the lead once", async () => {
    const w = world();
    const call = await startedCall(w, 1, { kind: "lead", propertyId: "prop-1" });
    w.p.dialMode = "timeout_noleg";
    await w.hook("call.answered", call.browserLegId, "browser", call.directCallId);
    expect(w.store.calls.get(call.directCallId)).toMatchObject({ status: "failed", failure_reason: "dial_outcome_unknown", resume_pending: true });
    await w.poll(call.directCallId);
    expect(w.resumes).toEqual([{ via: "service", propertyId: "prop-1" }]);
  });

  it("D3 a connected call is not resumed by the server (wrap-up owns that)", async () => {
    const w = world();
    const call = await startedCall(w, 1, { kind: "lead", propertyId: "prop-1" });
    await w.hook("call.answered", call.browserLegId, "browser", call.directCallId);
    const seller = w.store.calls.get(call.directCallId)!.seller_leg_id!;
    await w.hook("call.answered", seller, "seller", call.directCallId);
    await w.hook("call.hangup", seller, "seller", call.directCallId);
    expect(w.store.calls.get(call.directCallId)).toMatchObject({ status: "ended", resume_pending: false });
    await w.poll(call.directCallId);
    expect(w.resumes).toEqual([]);
  });

  it("D4 two non-terminal direct calls on the same property: the first to fail does not resume; the last one does", async () => {
    const w = world();
    const one = await startedCall(w, 1, { kind: "lead", propertyId: "prop-1" }, "user-1");
    const two = await startedCall(w, 2, { kind: "lead", propertyId: "prop-1" }, "user-2");
    w.store.calls.set(one.directCallId, { ...w.store.calls.get(one.directCallId)!, operator_user_id: "user-1" });
    await w.hook("call.hangup", one.browserLegId, "browser", one.directCallId);
    expect(w.store.calls.get(one.directCallId)).toMatchObject({ status: "failed", resume_pending: false });
    await w.poll(one.directCallId);
    expect(w.resumes).toEqual([]);
    await w.hook("call.hangup", two.browserLegId, "browser", two.directCallId);
    expect(w.store.calls.get(two.directCallId)?.resume_pending).toBe(true);
    await w.poll(two.directCallId, "user-2");
    expect(w.resumes).toEqual([{ via: "service", propertyId: "prop-1" }]);
  });

  it("D8 an unlinked manual call that fails resumes nothing; a linked one resumes once", async () => {
    const unlinked = world({ lead: false });
    const a = await startedCall(unlinked, 1, { kind: "manual", phone: "5550009999" });
    await unlinked.hook("call.hangup", a.browserLegId, "browser", a.directCallId);
    await unlinked.poll(a.directCallId);
    expect(unlinked.store.calls.get(a.directCallId)?.resume_pending).toBe(false);
    expect(unlinked.resumes).toEqual([]);
    const linked = world();
    const b = await startedCall(linked, 1, { kind: "lead", propertyId: "prop-9" });
    await linked.hook("call.hangup", b.browserLegId, "browser", b.directCallId);
    await linked.poll(b.directCallId);
    expect(linked.resumes).toEqual([{ via: "service", propertyId: "prop-9" }]);
  });

  it("D9 a training call that fails never pauses or resumes anything", async () => {
    const w = world({ lead: false });
    w.p.dialMode = "reject";
    expect(await w.start(1, { kind: "manual", phone: "training" })).toMatchObject({ ok: false });
    expect(w.resumes).toEqual([]);
  });
});
