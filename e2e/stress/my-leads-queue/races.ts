import { randomUUID } from "node:crypto";

import { Client } from "pg";

import { createRng, type Rng } from "../prng";
import { assertCommitLaneAllowed, assertOnlyHarnessLeads, HARNESS_ADDRESS_PREFIX } from "./guards";
import { fromChicagoLocal } from "./oracle";
import { materializeWorld, setupOrg, type OrgCtx } from "./materialize";
import { loadClassifierMigration } from "./migration";
import { DAY, HOUR, MIN, SEC, emptyLead, type Lead, type Msg, type World } from "./model";
import { place, addBusinessDays, minusChicagoDays, type Placement } from "./oracle";
import type { LaneResult } from "./report";
import { Reader } from "./runner";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Race and refresh lanes.
 *
 * SEND DRIVER. A lane needs "a rep's stamped text is in flight while the seller replies". The driver is pluggable:
 *   - `sql` (this file): replays the durable database protocol of `dispatchRepSms` step by step against the real database and the real
 *     stamp RPCs: reserve the ledger row, bind the reply-to stamp (first writer wins, one retry, `inbound_stamp_unresolved` when it
 *     cannot be established), insert the message `pending`, wait out the fake provider latency, flip it to `sent` with `sent_at`.
 *     It never calls a provider and never imports application code.
 *   - `dispatch` (race.dispatch.integration.test.ts): runs the real `dispatchRepSms` with the in-process fake provider.
 * Both feed the same assertions below.
 */
export type SendInput = {
  db: Client;
  ctx: OrgCtx;
  property: string;
  contact: string;
  /** The newest inbound the composer showed when it opened (the reply-to stamp the browser supplies). */
  inboundMessageId: string | null;
  latencyMs: number;
  /** Make the bind RPC fail (the lane that drops the function inside a transaction). */
  bindFails?: boolean;
};
export type SendDriver = { name: string; send(input: SendInput): Promise<{ messageId: string; stamped: boolean; unresolved: boolean }> };

export const sqlSendDriver: SendDriver = {
  name: "sql-protocol",
  async send({ db, ctx, property, contact, inboundMessageId, latencyMs }) {
    const ledger = randomUUID();
    await db.query(
      `insert into public.rep_sms_delivery_ledger(id,org_id,actor_user_id,submission_key,property_id,contact_id,sender_assignment_id,provider,provider_account_id,provider_sender_id,from_number,to_number,body,state,claim_token)
       values ($1,$2,$3,$4,$5,$6,$7,'sendillo','acct','sender','+18165550100','+18165550101','hi','reserved',$8)`,
      [ledger, ctx.org, ctx.rep, randomUUID(), property, contact, randomUUID(), randomUUID()]);
    // resolveRepSmsInboundStamp: the persisted stamp wins, otherwise bind the browser's id once; two attempts, then unresolved.
    let stamp: string | null = null;
    let unresolved = false;
    if (inboundMessageId) {
      let ok = false;
      for (let attempt = 0; attempt < 2 && !ok; attempt += 1) {
        try {
          // a savepoint so a missing function does not abort a caller-owned transaction
          await db.query("savepoint s1_bind");
          const r = await db.query("select public.fn_bind_rep_sms_inbound_stamp('draft',$1,$2,$3) as v", [ledger, ctx.org, inboundMessageId]);
          await db.query("release savepoint s1_bind");
          stamp = (r.rows[0].v as string | null) ?? null; ok = true;
        } catch {
          await db.query("rollback to savepoint s1_bind").catch(() => {});
        }
      }
      if (!ok) { stamp = null; unresolved = true; }
    }
    const messageId = randomUUID();
    const meta: Record<string, unknown> = { ...(stamp ? { inbound_message_id: stamp } : {}), ...(unresolved ? { inbound_stamp_unresolved: true } : {}) };
    await db.query(
      `insert into public.messages(id,org_id,channel,direction,body,status,property_id,contact_id,created_at,metadata)
       values ($1,$2,'sms','outbound','On our way','pending',$3,$4,clock_timestamp(),$5)`,
      [messageId, ctx.org, property, contact, JSON.stringify(meta)]);
    await sleep(latencyMs); // the fake provider "takes" this long to accept
    await db.query("update public.messages set status='sent', sent_at=clock_timestamp() where id=$1", [messageId]);
    await db.query("update public.rep_sms_delivery_ledger set state='accepted', message_id=$2, updated_at=clock_timestamp() where id=$1", [ledger, messageId]);
    return { messageId, stamped: !!stamp, unresolved };
  },
};

async function classify(db: Client, ctx: OrgCtx, at: Date): Promise<Map<string, Json>> {
  const r = await db.query("select * from public.my_leads_work_classified($1,$2,$3)", [ctx.org, ctx.rep, at.toISOString()]);
  return new Map(r.rows.map((x) => [x.property_id as string, x]));
}

const sameCell = (row: Json, p: Placement) => row.place === p.place && row.reason === p.reason && row.row_no === p.row;
const cell = (row: Json) => ({ place: row.place, reason: row.reason, row: row.row_no });

// ---------------- rolled-back lanes ----------------

/** Bind-RPC failure injection: inside a transaction the stamp function is renamed away, the send proceeds, nothing is committed. */
export async function laneBindFailure(url: string, reps: number, seed: number, driver: SendDriver = sqlSendDriver): Promise<LaneResult> {
  const lane: LaneResult = { id: "race:bind_rpc_failure", title: "bind RPC dropped inside a transaction: text carries the unresolved marker and handles nothing", runs: 0, failures: 0, samples: [], notes: [`driver ${driver.name}`] };
  const rng = createRng(seed);
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query("begin");
    await db.query(loadClassifierMigration());
    for (let n = 0; n < reps; n += 1) {
      await db.query("savepoint s1_bindfail");
      try {
        const now = Date.now();
        const ctx = await setupOrg(db);
        const lead = emptyLead(`bf${n}`, now, { messages: [{ ref: "x", dir: "inbound", at: now - HOUR, body: "call me" }] });
        const mat = await materializeWorld(db, ctx, { now, leads: [lead] });
        const property = mat.ids.get(lead.key)!;
        const contact = (await db.query("select homeowner_contact_id as c from public.properties where id=$1", [property])).rows[0].c as string;
        const x = mat.messageIds.get(lead.key)!.get("x")!;
        await db.query("alter function public.fn_bind_rep_sms_inbound_stamp(text,uuid,uuid,uuid) rename to fn_bind_rep_sms_inbound_stamp_s1_off");
        await db.query("set local session_replication_role='replica'");
        const sent = await driver.send({ db, ctx, property, contact, inboundMessageId: x, latencyMs: 0, bindFails: true });
        const at = new Date(Date.now() + 5 * SEC);
        const row = (await classify(db, ctx, at)).get(property)!;
        const meta = (await db.query("select metadata from public.messages where id=$1", [sent.messageId])).rows[0].metadata as Json;
        lane.runs += 1;
        const ok = sent.unresolved && meta.inbound_stamp_unresolved === true && !meta.inbound_message_id && row.row_no === "5" && row.reason === "new_reply";
        if (!ok) { lane.failures += 1; lane.samples.push({ rep: n, unresolved: sent.unresolved, metadata: meta, got: cell(row), expected: "row 5 new_reply: an accepted text with an unresolved stamp handles nothing" }); }
      } finally {
        await db.query("rollback to savepoint s1_bindfail").catch(() => {});
        await db.query("release savepoint s1_bindfail").catch(() => {});
      }
    }
  } finally {
    await db.query("rollback").catch(() => {});
    await db.end();
  }
  void rng;
  return lane;
}

/**
 * Refresh at next_change_at for each boundary family. One lead per world. The true change instant T* comes from the oracle (bisection to
 * 1 ms); then the SQL's `nextChangeAt` must (1) never be later than T* + 1 s, (2) show NO clock-only change before it, and (3) at it the
 * SQL placement must equal the oracle's. Earlier than T* is reported as an extra refresh, not a failure.
 */
export type BoundaryFamily = { id: string; build(now: number, rng: Rng): Lead; horizonMs: number };

const wedNoon = () => Date.UTC(2026, 9, 14, 17, 0, 0);
const off = (rng: Rng) => rng.int(20, 50) * SEC;
export const BOUNDARY_FAMILIES: readonly BoundaryFamily[] = [
  { id: "callback_due_soon", horizonMs: HOUR, build: (now, r) => emptyLead("b", now, { appointments: [{ ref: "a", due: now + 15 * MIN + off(r), status: "open" }] }) },
  { id: "snooze_expiring", horizonMs: HOUR, build: (now, r) => emptyLead("b", now, { appointments: [{ ref: "a", due: now - DAY, status: "snoozed", snoozedUntil: now + 15 * MIN + off(r) }] }) },
  { id: "missed_callback_7d", horizonMs: HOUR, build: (now, r) => emptyLead("b", now, { appointments: [{ ref: "a", due: minusChicagoDays(now, 7) + off(r), status: "open" }] }) },
  { id: "offer_chain_follow_up", horizonMs: HOUR, build: (now, r) => {
    const due = now + 15 * MIN + off(r);
    return emptyLead("b", now, { stage: "offer_sent", offer: { sentAt: now - 3 * DAY, followUpAt: due, outcome: "pending", hasChain: true }, appointments: [{ ref: "c", due, status: "open", offerChain: true }] });
  } },
  { id: "offer_legacy_follow_up", horizonMs: HOUR, build: (now, r) => emptyLead("b", now, { stage: "offer_sent", offer: { sentAt: now - 3 * DAY, followUpAt: now + 15 * MIN + off(r), outcome: "pending", hasChain: false } }) },
  { id: "texted_last_three_business_days", horizonMs: HOUR, build: (now, r) => {
    const target = now + off(r); // the deadline
    // a send time whose 3-business-day deadline is `target` (search back from target - 3 days, wall-clock)
    let sent = target - 3 * DAY;
    for (let i = 0; i < 12 && Math.abs(addBusinessDays(sent, 3) - target) > SEC; i += 1) sent += target - addBusinessDays(sent, 3);
    return emptyLead("b", now, { messages: [{ ref: "o", dir: "outbound", at: sent, body: "t", source: "human", outcome: "sent" }] });
  } },
  { id: "drip_next_run_overdue", horizonMs: 2 * HOUR, build: (now, r) => emptyLead("b", now, { enrollment: { status: "active", nextRunAt: now - 60 * MIN + off(r), updatedAt: now, enrolledAt: now - 3 * DAY, enrolledBy: "none", steps: 4, step: 1 } }) },
  { id: "drip_claim_stale", horizonMs: HOUR, build: (now, r) => emptyLead("b", now, { enrollment: { status: "active", nextRunAt: now + HOUR, updatedAt: now, enrolledAt: now - 3 * DAY, enrolledBy: "none", steps: 4, step: 1, claimAt: now - 15 * MIN + off(r) } }) },
  { id: "call_in_progress_stale", horizonMs: HOUR, build: (now, r) => emptyLead("b", now, { enrollment: { status: "paused", pause: "call_in_progress", nextRunAt: null, updatedAt: now - 30 * MIN + off(r), enrolledAt: now - 3 * DAY, enrolledBy: "none", steps: 4, step: 1 } }) },
  { id: "campaign_overdue", horizonMs: HOUR, build: (now, r) => emptyLead("b", now, { messages: [{ ref: "c", dir: "outbound", at: now - DAY, body: "c", source: "campaign", outcome: "queued", scheduledFor: now - 30 * MIN + off(r) }] }) },
  { id: "pending_text_stale", horizonMs: HOUR, build: (now, r) => emptyLead("b", now, { messages: [{ ref: "p", dir: "outbound", at: now - 15 * MIN + off(r), body: "p", source: "human", outcome: "pending" }] }) },
  { id: "ledger_in_flight_stale", horizonMs: HOUR, build: (now, r) => emptyLead("b", now, { ledgers: [{ ref: "l", state: "sending", updatedAt: now - 15 * MIN + off(r) }] }) },
  { id: "obligation_lease_expiry", horizonMs: HOUR, build: (now, r) => emptyLead("b", now, { obligations: [{ ref: "o", state: "claimed", updatedAt: now - HOUR, leaseExpiresAt: now + off(r) }] }) },
  { id: "failed_text_ages_out", horizonMs: HOUR, build: (now, r) => emptyLead("b", now, { messages: [{ ref: "f", dir: "outbound", at: now - 7 * DAY + off(r), body: "f", source: "human", outcome: "failed" }] }) },
  { id: "pin_expiry", horizonMs: HOUR, build: (now, r) => emptyLead("b", now, { pin: { pinnedAt: now - 2 * HOUR, until: now + off(r) } }) },
];

/** First instant at which the oracle's placement differs from the placement at `from` (1 ms resolution), or null within the horizon. */
export function firstChange(lead: Lead, from: number, horizonMs: number): number | null {
  const base = place(lead, from);
  const differs = (t: number) => { const p = place(lead, t); return p.row !== base.row || p.reason !== base.reason || p.place !== base.place; };
  // coarse scan for the first changed second, then bisect to the millisecond
  let lo = from, hi = -1;
  for (let t = from + SEC; t <= from + horizonMs; t += SEC) { if (differs(t)) { hi = t; break; } lo = t; }
  if (hi < 0) return null;
  while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (differs(mid)) hi = mid; else lo = mid; }
  return hi;
}

export async function laneRefresh(url: string, repeats: number, seed: number, families: readonly BoundaryFamily[] = BOUNDARY_FAMILIES): Promise<LaneResult[]> {
  const out: LaneResult[] = [];
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query("begin");
    await db.query(loadClassifierMigration());
    for (const fam of families) {
      const lane: LaneResult = { id: `refresh:${fam.id}`, title: `refresh at next_change_at: ${fam.id}`, runs: 0, failures: 0, samples: [], notes: [] };
      let early = 0;
      for (let n = 0; n < repeats; n += 1) {
        const rng = createRng(seed * 7919 + n * 31 + fam.id.length);
        const now = wedNoon() + rng.int(0, 20) * 7 * DAY; // always a Wednesday: weekday deadlines exist, and some weeks straddle a DST change
        const lead = fam.build(now, rng);
        const tStar = firstChange(lead, now, fam.horizonMs);
        await db.query("savepoint s1_refresh");
        try {
          const ctx = await setupOrg(db);
          const world: World = { now, leads: [lead] };
          const mat = await materializeWorld(db, ctx, world);
          const property = mat.ids.get(lead.key)!;
          const reader = (at: number) => new Reader(db, ctx, ctx.rep, new Date(at), ctx.rep);
          const page0 = await reader(now).page("all", null, 1, 25);
          const nextChange = page0.nextChangeAt ? Date.parse(page0.nextChangeAt) : null;
          lane.runs += 1;
          const fail = (why: string, extra: Json = {}) => { lane.failures += 1; lane.samples.push({ repeat: n, why, now: iso(now), tStar: tStar ? iso(tStar) : null, nextChangeAt: page0.nextChangeAt, ...extra }); };
          if (tStar === null) { fail("oracle found no change inside the horizon: the boundary lead is wrong"); continue; }
          if (nextChange === null) { fail("SQL reported no next_change_at but the oracle sees a clock-only change", { oracle: place(lead, tStar) }); continue; }
          if (nextChange > tStar + SEC) { fail("next_change_at is later than the true change + 1 s: a refresh there would show the old placement for too long"); continue; }
          if (nextChange < tStar) early += 1;
          const before = (await reader(nextChange - 1).page("all", null, 1, 25)).rows.find((r: Json) => r.propertyId === property);
          const start = page0.rows.find((r: Json) => r.propertyId === property);
          if (before.place !== start.place || before.reason !== start.reason) { fail("the SQL placement changed before next_change_at (a clock-only change the refresh would miss)", { start: [start.place, start.reason], before: [before.place, before.reason] }); continue; }
          const atChange = (await reader(nextChange).page("all", null, 1, 25)).rows.find((r: Json) => r.propertyId === property);
          const want = place(lead, nextChange);
          if (atChange.place !== want.place || atChange.reason !== want.reason || atChange.rowNo !== want.row)
            fail("at next_change_at the SQL placement differs from the oracle", { sql: [atChange.place, atChange.reason, atChange.rowNo], oracle: [want.place, want.reason, want.row] });
        } finally {
          await db.query("rollback to savepoint s1_refresh").catch(() => {});
          await db.query("release savepoint s1_refresh").catch(() => {});
        }
      }
      if (early) lane.notes!.push(`${early} early refresh${early === 1 ? "" : "es"} (next_change_at before the true change; harmless)`);
      out.push(lane);
    }
  } finally {
    await db.query("rollback").catch(() => {});
    await db.end();
  }
  return out;
}

// ---------------- committed lanes (disposable database only) ----------------

async function commitWorld(db: Client, lead: Lead, now: number) {
  // A no-expiry pin drops a check constraint (rolled back elsewhere); never let that commit.
  if (lead.pin) throw new Error("committed lanes may not seed pins");
  await db.query("begin");
  try {
    const ctx = await setupOrg(db);
    const mat = await materializeWorld(db, ctx, { now, leads: [lead] });
    await db.query("update public.properties set address = $2 || address where id=$1", [mat.ids.get(lead.key)!, HARNESS_ADDRESS_PREFIX]);
    await db.query("commit");
    return { ctx, property: mat.ids.get(lead.key)!, refs: mat.messageIds.get(lead.key)! };
  } catch (error) {
    await db.query("rollback").catch(() => {});
    throw error;
  }
}

async function replicaClient(url: string): Promise<Client> {
  const c = new Client({ connectionString: url });
  await c.connect();
  await c.query("set session_replication_role = replica");
  return c;
}

export async function preflightCommitLanes(url: string): Promise<string | null> {
  assertCommitLaneAllowed();
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    const have = await c.query("select to_regprocedure('public.my_leads_work_classified(uuid,uuid,timestamptz)') as f");
    if (!have.rows[0].f) return "the classifier migration (20261015010000) is not applied to this database; the committed race lanes need it applied";
    const counts = (await c.query("select count(*)::int as properties, count(*) filter (where address not like $1)::int as foreign from public.properties", [`${HARNESS_ADDRESS_PREFIX}%`])).rows[0];
    assertOnlyHarnessLeads(counts);
    return null;
  } finally {
    await c.end();
  }
}

/**
 * Writer B starts a human send stamped X; writer A inserts inbound Y 50-500 ms later; the fake provider takes 100-900 ms to accept, so Y
 * lands both before and after the text's created_at / sent_at. Afterwards Y must be unhandled (row 5, New reply, latest inbound = Y).
 */
export const unstampedSendDriver: SendDriver = { name: "sql-protocol-without-stamp (mutation)", send: (input) => sqlSendDriver.send({ ...input, inboundMessageId: null }) };

export async function laneStampedSendVsInbound(url: string, reps: number, seed: number, driver: SendDriver = sqlSendDriver, timing: { latencyMs: [number, number]; yDelayMs: [number, number] } = { latencyMs: [100, 900], yDelayMs: [50, 500] }): Promise<LaneResult> {
  const lane: LaneResult = { id: "race:stamped_send_vs_inbound", title: "concurrent inbound Y 50-500 ms after a stamped send for X begins: Y stays unhandled", runs: 0, failures: 0, samples: [], notes: [`driver ${driver.name}`] };
  const rng = createRng(seed);
  const admin = new Client({ connectionString: url });
  await admin.connect();
  let yBeforeSend = 0, yAfterAccept = 0;
  try {
    for (let n = 0; n < reps; n += 1) {
      const now = Date.now();
      const lead = emptyLead(`r${n}`, now, { messages: [{ ref: "x", dir: "inbound", at: now - HOUR, body: "call me" }] });
      const { ctx, property, refs } = await commitWorld(admin, lead, now);
      const contact = (await admin.query("select homeowner_contact_id as c from public.properties where id=$1", [property])).rows[0].c as string;
      const b = await replicaClient(url), a = await replicaClient(url);
      const latencyMs = rng.int(timing.latencyMs[0], timing.latencyMs[1]), yDelay = rng.int(timing.yDelayMs[0], timing.yDelayMs[1]);
      let y = "";
      let sentId = "";
      try {
        const send = driver.send({ db: b, ctx, property, contact, inboundMessageId: refs.get("x")!, latencyMs });
        const reply = (async () => {
          await sleep(yDelay);
          y = randomUUID();
          await a.query("insert into public.messages(id,org_id,channel,direction,body,status,property_id,contact_id,created_at,metadata) values ($1,$2,'sms','inbound','Actually, make it Friday','received',$3,$4,clock_timestamp(),'{}')", [y, ctx.org, property, contact]);
        })();
        const [sent] = await Promise.all([send, reply]);
        sentId = sent.messageId;
      } finally {
        await b.end(); await a.end();
      }
      // classify from what the database recorded, not from the intended delays
      const t = (await admin.query("select (select created_at from public.messages where id=$1) as y, sent_at from public.messages where id=$2", [y, sentId])).rows[0];
      if (!t?.sent_at) { lane.runs += 1; lane.failures += 1; lane.samples.push({ rep: n, why: "the send was never accepted (no sent_at)" }); continue; }
      if (t.y < t.sent_at) yBeforeSend += 1; else yAfterAccept += 1;
      const row = (await classify(admin, ctx, new Date(Date.now() + 5 * SEC))).get(property)!;
      lane.runs += 1;
      const latest = row.facts.latestInbound;
      if (!(row.row_no === "5" && latest?.messageId === y && latest?.handled === false)) {
        lane.failures += 1;
        lane.samples.push({ rep: n, latencyMs, yDelay, got: cell(row), latestInbound: latest, expected: "row 5, latest inbound = Y, handled=false" });
      }
    }
  } finally {
    await admin.end();
  }
  lane.notes!.push(`by database timestamps, Y was created before the text's sent_at in ${yBeforeSend} runs and after it in ${yAfterAccept}`);
  // The stamp only matters when Y lands before the send time; a lane that never produced that ordering proved nothing.
  if (reps >= 10 && yBeforeSend < Math.ceil(reps / 4)) { lane.failures += 1; lane.samples.push({ why: `only ${yBeforeSend} of ${reps} runs had Y before sent_at; the lane did not exercise the stamp` }); }
  return lane;
}

/**
 * A late delivery_failed status event flips an accepted text to failed while the queue is being read continuously. Every observation
 * must be a valid state of the sequence (Texted last before the event, Broken after it), X must stay handled, and with a newer Y after the
 * flip the lead must show New reply.
 */
export async function laneLateDeliveryFailure(url: string, reps: number, seed: number): Promise<LaneResult> {
  const lane: LaneResult = { id: "race:late_delivery_failed", title: "late delivery_failed after acceptance: reply stays handled, lead goes Broken; a newer inbound makes it New reply", runs: 0, failures: 0, samples: [], notes: [] };
  const rng = createRng(seed);
  const admin = new Client({ connectionString: url });
  await admin.connect();
  try {
    for (let n = 0; n < reps; n += 1) {
      const now = Date.now();
      const withY = n % 2 === 1;
      const sentAt = now - 10 * MIN;
      const lead = emptyLead(`l${n}`, now, { messages: [
        { ref: "x", dir: "inbound", at: now - HOUR, body: "call me" },
        { ref: "o", dir: "outbound", at: sentAt, body: "On our way", source: "human", outcome: "sent", sentAt, stamp: { kind: "inbound", ref: "x" } } as Msg,
      ] });
      const { ctx, property, refs } = await commitWorld(admin, lead, now);
      const contact = (await admin.query("select homeowner_contact_id as c from public.properties where id=$1", [property])).rows[0].c as string;
      const w = await replicaClient(url);
      const stop = { v: false };
      const seen: string[] = [];
      const poll = (async () => {
        while (!stop.v) { const row = (await classify(admin, ctx, new Date(Date.now() + SEC))).get(property)!; seen.push(`${row.row_no}`); await sleep(15); }
      })();
      try {
        await sleep(rng.int(30, 200));
        await w.query("update public.messages set status='failed', failed_at=clock_timestamp() where id=$1", [refs.get("o")!]);
        if (withY) {
          await sleep(rng.int(20, 120));
          await w.query("insert into public.messages(id,org_id,channel,direction,body,status,property_id,contact_id,created_at,metadata) values ($1,$2,'sms','inbound','wait','received',$3,$4,clock_timestamp(),'{}')", [randomUUID(), ctx.org, property, contact]);
        }
        await sleep(rng.int(30, 120));
      } finally {
        stop.v = true; await poll; await w.end();
      }
      const final = (await classify(admin, ctx, new Date(Date.now() + 5 * SEC))).get(property)!;
      lane.runs += 1;
      const allowed = new Set(withY ? ["13", "6", "5"] : ["13", "6"]);
      const bad = seen.filter((s) => !allowed.has(s));
      const wantFinal = withY ? "5" : "6";
      // monotone: once Broken/New reply is seen it never goes back to Texted last
      const firstNon13 = seen.findIndex((s) => s !== "13");
      const regressed = firstNon13 >= 0 && seen.slice(firstNon13).includes("13");
      if (bad.length || regressed || final.row_no !== wantFinal) {
        lane.failures += 1;
        lane.samples.push({ rep: n, withY, sequence: seen.join(","), final: final.row_no, expected: wantFinal });
      }
    }
  } finally {
    await admin.end();
  }
  return lane;
}

export async function runCommittedLanes(url: string, reps: number, seed: number, driver: SendDriver = sqlSendDriver): Promise<LaneResult[]> {
  const skip = await preflightCommitLanes(url).catch((error: Error) => error.message);
  if (skip) {
    return [
      { id: "race:stamped_send_vs_inbound", title: "concurrent inbound after a stamped send", runs: 0, failures: 0, skipped: skip, samples: [] },
      { id: "race:late_delivery_failed", title: "late delivery_failed after acceptance", runs: 0, failures: 0, skipped: skip, samples: [] },
    ];
  }
  return [await laneStampedSendVsInbound(url, reps, seed, driver), await laneLateDeliveryFailure(url, Math.max(20, Math.floor(reps / 4)), seed + 1)];
}

void fromChicagoLocal; void DAY;
