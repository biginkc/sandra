import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Harness } from "../stress/harness";
import { rng } from "../stress/trace";

/**
 * Stage 2 (20261009010100_norma_call_queue) on the full chain: main + stage 1 + stage 2. The new AFTER triggers sit on
 * hot tables (messages, properties, contacts, consent_events). These tests drive MAIN's current write paths against
 * them: the inbound-SMS insert (the column set of insertInboundMessage, src/lib/messaging/inbound.ts), the property
 * disposition/status updates, the contact DNC / STOP writes (the Harness helpers mirror the runtime statements), and
 * the consent event row recordConsentEvent writes (src/lib/messaging/consent.ts).
 * They assert the writes succeed, land exactly as before, and touch the queue tables only for a lead that has a live
 * queue entry.
 */
let h: Harness;
beforeAll(async () => {
  h = await Harness.create(rng(202));
});
afterAll(async () => {
  await h?.close();
});

const pool = () => h.scratch.pool;
const QUEUE_TABLES = ["norma_queue_entries", "norma_queue_attempts", "norma_queue_digests", "norma_followup_reassignments"] as const;

async function queueSnapshot(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const t of QUEUE_TABLES) {
    out[t] = JSON.stringify((await pool().query(`select * from public.${t} order by to_jsonb(${t})::text`)).rows);
  }
  out.control = JSON.stringify((await pool().query("select * from public.norma_queue_control")).rows);
  return out;
}

async function enqueue(property: string) {
  const r = await pool().query<{ result: string; entry_id: string }>(
    "select result, entry_id from public.fn_norma_queue_enqueue($1::uuid, $2::uuid, array[$3::uuid], 'trigger test')",
    [h.world.org, h.world.rep1, property],
  );
  expect(r.rows[0]?.result).toBe("queued");
  return r.rows[0]!.entry_id;
}

const entry = async (id: string) =>
  (await pool().query("select status, pause_reason, blocked_reason, end_reason from public.norma_queue_entries where id = $1", [id])).rows[0];

/** The inbound SMS persist: same column set as insertInboundMessage. */
async function inboundSms(ctx: { lead: { property: string; contact: string; phone: string } }, createdAt?: Date) {
  const r = await pool().query(
    `insert into public.messages (org_id, channel, direction, status, provider, external_id, from_address, to_address, body, contact_id, property_id, created_at)
     values ($1, 'sms', 'inbound', 'received', 'sendillo', $2, $3, '+18165550000', 'who is this?', $4, $5, coalesce($6::timestamptz, now())) returning id, direction, status, body, property_id`,
    [h.world.org, `ext-${randomUUID()}`, ctx.lead.phone, ctx.lead.contact, ctx.lead.property, createdAt?.toISOString() ?? null],
  );
  return r.rows[0];
}

/** The consent event row recordConsentEvent writes. */
async function consentEvent(ctx: { lead: { contact: string } }, eventType: string, channel = "sms") {
  const id = randomUUID();
  await pool().query(
    "insert into public.consent_events (id, org_id, contact_id, channel, event_type, source, source_detail, occurred_at) values ($1, $2, $3, $4, $5, 'stress_test', '{}'::jsonb, now())",
    [id, h.world.org, ctx.lead.contact, channel, eventType],
  );
  return id;
}

const propertyRow = async (id: string) => (await pool().query("select status, outreach_dispo, is_dnc_locked from public.properties where id = $1", [id])).rows[0];
const contactRow = async (id: string) => (await pool().query("select do_not_contact, sms_opted_out from public.contacts where id = $1", [id])).rows[0];

describe("stage 2 triggers with NO queue entries: writes succeed, land as before, queue tables untouched", () => {
  it("inbound SMS insert, disposition/status update, DNC and STOP writes, consent events", async () => {
    const ctx = await h.lead({ enrollments: ["active"] });
    const before = await queueSnapshot();

    const msg = await inboundSms(ctx);
    expect(msg).toMatchObject({ direction: "inbound", status: "received", body: "who is this?", property_id: ctx.lead.property });

    await h.notInterested(ctx);
    expect(await propertyRow(ctx.lead.property)).toMatchObject({ outreach_dispo: "not_interested", status: "new_lead" });
    await pool().query("update public.properties set status = 'contacted', updated_at = now() where id = $1", [ctx.lead.property]);
    expect((await propertyRow(ctx.lead.property)).status).toBe("contacted");

    const stopped = await h.lead({ enrollments: ["active"] });
    await h.stop(stopped);
    expect(await contactRow(stopped.lead.contact)).toMatchObject({ sms_opted_out: true });
    expect(await propertyRow(stopped.lead.property)).toMatchObject({ outreach_dispo: "opted_out" });
    const dncContact = await h.lead({ enrollments: ["active"] });
    await h.dnc(dncContact, "contact");
    expect(await contactRow(dncContact.lead.contact)).toMatchObject({ do_not_contact: true });
    const dncLock = await h.lead({ enrollments: ["active"] });
    await h.dnc(dncLock, "lock");
    expect(await propertyRow(dncLock.lead.property)).toMatchObject({ is_dnc_locked: true, outreach_dispo: "dnc" });

    const ids = [await consentEvent(ctx, "opt_in_informational"), await consentEvent(ctx, "opt_out"), await consentEvent(ctx, "help_request")];
    const stored = await pool().query("select id from public.consent_events where contact_id = $1 and id = any($2::uuid[])", [ctx.lead.contact, ids]);
    expect(stored.rowCount).toBe(3);

    expect(await queueSnapshot()).toEqual(before);
  });
});

describe("stage 2 triggers WITH queue entries: only the affected lead's entry moves", () => {
  it("an inbound reply parks that lead's entry; a bystander entry and a lead with no entry are untouched", async () => {
    const a = await h.lead({ enrollments: ["active"] });
    const bystander = await h.lead({ enrollments: ["active"] });
    const none = await h.lead({ enrollments: ["active"] });
    const entryA = await enqueue(a.lead.property);
    const entryB = await enqueue(bystander.lead.property);

    const beforeBystander = await entry(entryB);
    const snapNoEntryLead = await queueSnapshot();
    await inboundSms(none);
    expect(await queueSnapshot()).toEqual(snapNoEntryLead);

    // A reply must be newer than the entry itself to park it; one in the past must not.
    await inboundSms(a, new Date(Date.now() - 3600_000));
    expect(await entry(entryA)).toMatchObject({ status: "queued", pause_reason: null });
    await inboundSms(a);
    expect(await entry(entryA)).toMatchObject({ status: "paused", pause_reason: "inbound_reply" });
    expect(await entry(entryB)).toEqual(beforeBystander);
  });

  it("a disposition change closes the entry as blocked; the same write on a lead with no entry changes no queue row", async () => {
    const withEntry = await h.lead({ enrollments: ["active"] });
    const bystander = await h.lead({ enrollments: ["active"] });
    const none = await h.lead({ enrollments: ["active"] });
    const e = await enqueue(withEntry.lead.property);
    const eb = await enqueue(bystander.lead.property);
    const beforeB = await entry(eb);

    const snap = await queueSnapshot();
    await h.notInterested(none);
    expect(await queueSnapshot()).toEqual(snap);

    await h.notInterested(withEntry);
    expect(await entry(e)).toMatchObject({ status: "done", blocked_reason: "not_interested" });
    expect(await entry(eb)).toEqual(beforeB);
  });

  it("a contact DNC write blocks that lead's entry only", async () => {
    const withEntry = await h.lead({ enrollments: ["active"] });
    const bystander = await h.lead({ enrollments: ["active"] });
    const e = await enqueue(withEntry.lead.property);
    const eb = await enqueue(bystander.lead.property);
    const beforeB = await entry(eb);
    await h.dnc(withEntry, "contact");
    const after = await entry(e);
    expect(after.status).toBe("done");
    expect(after.blocked_reason).toBeTruthy();
    expect(await entry(eb)).toEqual(beforeB);
  });

  it("a STOP (sms opt-out) write blocks that lead's entry", async () => {
    const withEntry = await h.lead({ enrollments: ["active"] });
    const e = await enqueue(withEntry.lead.property);
    await h.stop(withEntry);
    const after = await entry(e);
    expect(after.status).toBe("done");
    expect(after.blocked_reason).toBeTruthy();
  });

  it("a consent opt-out event blocks that lead's entry; an informational event does not", async () => {
    const withEntry = await h.lead({ enrollments: ["active"] });
    const bystander = await h.lead({ enrollments: ["active"] });
    const e = await enqueue(withEntry.lead.property);
    const eb = await enqueue(bystander.lead.property);
    const beforeB = await entry(eb);

    await consentEvent(withEntry, "help_request");
    expect(await entry(e)).toMatchObject({ status: "queued", blocked_reason: null });

    await consentEvent(withEntry, "opt_out", "voice");
    const after = await entry(e);
    expect(after.status).toBe("done");
    expect(after.blocked_reason).toBeTruthy();
    expect(await entry(eb)).toEqual(beforeB);
  });
});

describe("stage 2: the CURRENT runtime button path (legacy claim stays disabled)", () => {
  it("stays requested, never dials, then reconcile rejects it and releases the drip pauses", async () => {
    const ctx = await h.lead({ enrollments: ["active"] });
    const reportsBefore = h.reports.length;
    const sendsBefore = h.bland.sends.length;
    const queueBefore = await queueSnapshot();

    const res = await h.requestCall(ctx, h.world.rep1);
    expect(res).toMatchObject({ ok: false, code: "in_flight" });
    const row = async () => (await pool().query("select id, status, bland_call_id from public.norma_call_requests where property_id=$1", [ctx.lead.property])).rows[0];
    const first = await row();
    expect(first).toMatchObject({ status: "requested", bland_call_id: null });
    // The old path creates no queue linkage.
    const linked = await pool().query("select queue_entry_id, queue_lease_token, queue_dispatch_token, send_attempted_at from public.norma_call_requests where id = $1", [first.id]);
    expect(linked.rows[0]).toEqual({ queue_entry_id: null, queue_lease_token: null, queue_dispatch_token: null, send_attempted_at: null });

    await h.advance(2 * 60_000);
    await h.reconcile();
    expect((await row()).status).toBe("requested");
    await h.advance(4 * 60_000);
    await h.reconcile();
    expect((await row()).status).toBe("dispatch_rejected");
    const pauses = await pool().query("select released_at from public.norma_enrollment_pauses where request_id = $1", [first.id]);
    expect(pauses.rows.length).toBeGreaterThan(0);
    expect(pauses.rows.every((p) => p.released_at !== null)).toBe(true);
    expect((await pool().query("select status from public.sequence_enrollments where id = $1", [ctx.lead.enrollments[0]])).rows[0].status).toBe("active");

    expect(h.bland.sends.length).toBe(sendsBefore);
    expect(h.reports.slice(reportsBefore)).toEqual([]);
    expect(await queueSnapshot()).toEqual(queueBefore);
  });
});
