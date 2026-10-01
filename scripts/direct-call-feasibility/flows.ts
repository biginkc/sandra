/* eslint-disable @typescript-eslint/no-explicit-any */
// Interactive test flows F1-F7. Each is run only in live mode with the operator present.
// Results are appended to .run/results.jsonl for transcription into FEASIBILITY.md.
import fs from "node:fs";
import path from "node:path";
import type { Config } from "./env";
import type { EventLog, LoggedEvent } from "./event-log";
import type { Inventory } from "./inventory";
import type { TelnyxClient } from "./telnyx-client";
import type { StreamStats } from "./stream-server";

export interface FlowCtx {
  client: TelnyxClient;
  inv: Inventory;
  cfg: Config;
  log: EventLog;
  stats: StreamStats;
  ask: (q: string) => Promise<string>;
  say: (s: string) => void;
}

function record(ctx: FlowCtx, name: string, data: unknown): void {
  ctx.say(`[${name}] ${JSON.stringify(data)}`);
  if (ctx.inv.runDir) fs.appendFileSync(path.join(ctx.inv.runDir, "results.jsonl"), JSON.stringify({ name, at: new Date().toISOString(), data }) + "\n");
}

const yes = (s: string) => /^y(es)?$/i.test(s.trim());
const waitMs = (ctx: FlowCtx) => (ctx.cfg.limits.ringTimeoutSecs + 5) * 1000;
const isEvt = (type: string, ccid: string) => (e: LoggedEvent) => e.source === "webhook" && e.type === type && e.callControlId === ccid;

function phone(ctx: FlowCtx, i = 0): string {
  return ctx.cfg.testPhones[i] ?? ctx.cfg.testPhones[0];
}

/** Server dials the browser SIP username, waits for answer, then dials the phone with link_to. */
async function placeBridged(ctx: FlowCtx, clientState?: string) {
  const sip = ctx.inv.getRole("browserSipUsername");
  if (!sip) throw new Error("run setup first");
  const t0 = Date.now();
  const rep = await ctx.client.dial({ to: `sip:${sip}@sip.telnyx.com`, clientState });
  if (!rep.callControlId) throw new Error("no leg id returned for browser leg");
  ctx.say("Answer in the browser page now.");
  const answered = await ctx.log.waitFor(isEvt("call.answered", rep.callControlId), waitMs(ctx));
  if (!answered) return { ok: false as const, reason: "browser leg not answered", rep };
  const seller = await ctx.client.dial({ to: phone(ctx), linkTo: rep.callControlId, bridgeOnAnswer: true, bridgeIntent: false });
  if (!seller.callControlId) throw new Error("no leg id returned for seller leg");
  const ringing = await ctx.log.waitFor(isEvt("call.initiated", seller.callControlId), 5000);
  const sellerAnswered = await ctx.log.waitFor(isEvt("call.answered", seller.callControlId), waitMs(ctx));
  const t1 = Date.now();
  return { ok: !!sellerAnswered, reason: sellerAnswered ? undefined : "seller leg not answered", rep, seller, t0, t1, ringing };
}

async function endLegs(ctx: FlowCtx, ids: (string | undefined)[]): Promise<void> {
  for (const id of ids) if (id) {
    try { await ctx.client.request("POST", `/calls/${id}/actions/hangup`, {}); } catch { /* may already be ended */ }
  }
}

export async function f1(ctx: FlowCtx): Promise<void> {
  for (let i = 1; i <= 5; i++) {
    ctx.say(`F1 run ${i}/5`);
    const r = await placeBridged(ctx);
    if (!r.ok) { record(ctx, "F1", { run: i, failed: r.reason }); await endLegs(ctx, [r.rep.callControlId]); continue; }
    const audio = await ctx.ask("Two-way audio both directions? (y/n) ");
    const cid = await ctx.ask("Test phone showed the expected caller ID? (y/n) ");
    record(ctx, "F1", { run: i, browserLeg: r.rep.callControlId, sellerLeg: r.seller.callControlId, answeredMs: r.t1 - r.t0, twoWay: yes(audio), callerIdOk: yes(cid) });
    await endLegs(ctx, [r.seller.callControlId, r.rep.callControlId]);
    await ctx.log.waitFor(isEvt("call.hangup", r.seller.callControlId!), 10000);
  }
}

/** F2: operator drives escape attempts from the browser page; script lists and ends any legs found. */
export async function f2(ctx: FlowCtx): Promise<void> {
  const bound = ctx.cfg.limits.maxLegSecs;
  const conn = ctx.inv.getRole("connectionId");
  if (!conn) throw new Error("run setup first");
  const dis = (await ctx.client.request("GET", `/outbound_voice_profiles/${ctx.inv.getRole("disabledProfileId")}`)).data;
  record(ctx, "F2-bound", { disabledProfileEnabled: dis.enabled, requiredMaxLegSecs: bound });
  const proof = await ctx.ask(`A provider-side duration bound at or below ${bound}s must exist for browser-originated legs. Confirmed shown by read-back? (y/n; n = probes NOT run, F2 not passed) `);
  if (!yes(proof)) { record(ctx, "F2", { result: "NOT RUN: containment bound not shown; F2 not passed" }); return; }
  for (const probe of ["pstn", "on-account-sip", "external-sip", "transfer"]) {
    await ctx.ask(`In the browser page, run the "${probe}" escape attempt (registered, spare capacity), then press Enter. `);
    const legs = ((await ctx.client.request("GET", `/connections/${conn}/active_calls`)).data as any[]) ?? [];
    for (const l of legs) { ctx.inv.add("call_leg", l.call_control_id); }
    await endLegs(ctx, legs.map((l) => l.call_control_id));
    const code = await ctx.ask("Provider rejection code/reason shown in the page log (or 'none'): ");
    const valid = await ctx.ask("Was it a valid request to a known-working owned destination from a registered browser? (y/n) ");
    record(ctx, "F2", { probe, legsFoundAndEnded: legs.map((l) => l.call_control_id), code, validRequest: yes(valid), note: "inconclusive unless reason is attributable to the restriction" });
  }
}

export async function f3(ctx: FlowCtx): Promise<void> {
  const r = await placeBridgedBrowserOnly(ctx);
  if (!r) return;
  const seen = ctx.log.all().filter((e) => e.source === "browser" && e.type === "call.incoming");
  record(ctx, "F3", { serverLeg: r, browserSaw: seen.map((e) => e.data) });
  const eq = await ctx.ask("Does call.telnyxIDs seen BEFORE answering equal the server leg ID above? (y/n) ");
  record(ctx, "F3-equal", { equal: yes(eq) });
  await endLegs(ctx, [r]);
}

async function placeBridgedBrowserOnly(ctx: FlowCtx): Promise<string | undefined> {
  const sip = ctx.inv.getRole("browserSipUsername");
  if (!sip) throw new Error("run setup first");
  const rep = await ctx.client.dial({ to: `sip:${sip}@sip.telnyx.com`, clientState: "f3-marker" });
  ctx.say("Browser should log the incoming call BEFORE you press answer. Check, then answer or let it ring.");
  await ctx.log.waitFor(isEvt("call.answered", rep.callControlId ?? ""), waitMs(ctx));
  return rep.callControlId;
}

export async function f4(ctx: FlowCtx): Promise<void> {
  const r = await placeBridged(ctx);
  if (!r.ok || !r.seller.callControlId) return record(ctx, "F4", { failed: r.reason });
  const wsUrl = `${ctx.cfg.publicBaseUrl.replace(/^https/, "wss")}/stream`;
  await ctx.client.request("POST", `/calls/${r.seller.callControlId}/actions/streaming_start`, { stream_url: wsUrl, stream_track: "both_tracks" });
  await ctx.ask("Speak a marker on the rep (browser) side only for 5s, then the phone side only for 5s. Press Enter. ");
  record(ctx, "F4", { startFrames: ctx.stats.startFrames, bytesByTrack: ctx.stats.bytesByTrack });
  await ctx.ask("Which track was the seller, which the rep (inbound/outbound)? Note it in FEASIBILITY.md. Press Enter to end. ");
  await endLegs(ctx, [r.seller.callControlId, r.rep.callControlId]);
}

export async function f5(ctx: FlowCtx): Promise<void> {
  const r = await placeBridged(ctx);
  if (!r.ok || !r.seller.callControlId) return record(ctx, "F5", { failed: r.reason });
  await ctx.client.request("POST", `/calls/${r.seller.callControlId}/actions/record_start`, { format: "mp3", channels: "dual" });
  await ctx.ask("Speak on the rep side then the phone side, then press Enter. ");
  await endLegs(ctx, [r.seller.callControlId, r.rep.callControlId]);
  const saved = await ctx.log.waitFor((e) => e.type === "call.recording.saved" && e.callControlId === r.seller.callControlId, 30000);
  const recId = (saved?.data as any)?.payload?.recording_id as string | undefined;
  if (recId) {
    ctx.inv.add("recording", recId);
    const first = await ctx.client.request("GET", `/recordings/${recId}`);
    await ctx.ask("Wait until the first download link has expired (see Telnyx docs), then press Enter. ");
    const second = await ctx.client.request("GET", `/recordings/${recId}`);
    record(ctx, "F5", { recordingId: recId, firstFetched: !!first.data, refetchedAfterExpiry: !!second.data, channels: "dual; note party-to-channel mapping manually" });
  } else record(ctx, "F5", { failed: "call.recording.saved not received in 30s" });
}

export async function f6(ctx: FlowCtx): Promise<void> {
  const r = await placeBridged(ctx);
  if (!r.ok || !r.seller.callControlId) return record(ctx, "F6", { failed: r.reason });
  await ctx.client.request("POST", `/calls/${r.seller.callControlId}/actions/send_dtmf`, { digits: "1" });
  const a = await ctx.ask("Did the test phone receive the server-sent DTMF? (y/n) ");
  await ctx.ask("Press a keypad digit in the browser page, then press Enter. ");
  const b = await ctx.ask("Did the test phone receive the browser SDK DTMF? (y/n) ");
  await ctx.client.request("POST", `/calls/${r.seller.callControlId}/actions/hangup`, {});
  const h1 = await ctx.log.waitFor(isEvt("call.hangup", r.seller.callControlId), 15000);
  const h2 = await ctx.log.waitFor(isEvt("call.hangup", r.rep.callControlId!), 15000);
  record(ctx, "F6", { serverDtmf: yes(a), browserDtmf: yes(b), bothHangupWebhooks: !!h1 && !!h2 });
}

/** F7 (D4: no recovery). Fault injected on the browser leg; the seller leg must end on its own within the deadline. */
export async function f7(ctx: FlowCtx): Promise<void> {
  for (const fault of ["clean-hangup", "killed-tab", "network-cut"]) {
    const r = await placeBridged(ctx);
    if (!r.ok || !r.seller.callControlId || !r.rep.callControlId) { record(ctx, "F7", { fault, failed: r.reason }); await endLegs(ctx, [r.rep.callControlId]); continue; }
    await ctx.ask(`Get ready to inject "${fault}" in the browser. Press Enter, then inject IMMEDIATELY and type the moment with 'now' + Enter. `);
    await ctx.ask("Type 'now' at the moment of injection: ");
    const t0 = Date.now();
    const deadline = ctx.cfg.limits.f7DeadlineSecs * 1000;
    const sellerEnd = await ctx.log.waitFor(isEvt("call.hangup", r.seller.callControlId), deadline);
    const sellerMs = sellerEnd ? Date.parse(sellerEnd.receivedAt) - t0 : undefined;
    const browserEnd = ctx.log.find(isEvt("call.hangup", r.rep.callControlId));
    record(ctx, "F7", {
      fault,
      sellerEndedWithinDeadline: !!sellerEnd,
      sellerMs,
      sellerCause: (sellerEnd?.data as any)?.payload?.hangup_cause,
      browserEndedAt: browserEnd?.receivedAt,
      note: "pass only if the seller ended on its own: not by cap expiry and not by the cleanup below",
    });
    // Cleanup AFTER measurement, recorded as cleanup (a cleanup-caused end is a fail).
    await endLegs(ctx, [r.seller.callControlId, r.rep.callControlId]);
  }
}

export const FLOWS: Record<string, (ctx: FlowCtx) => Promise<void>> = { f1, f2, f3, f4, f5, f6, f7 };
