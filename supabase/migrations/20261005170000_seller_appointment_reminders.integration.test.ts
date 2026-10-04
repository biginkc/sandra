import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { expect, it } from 'vitest';
import { loadTestEnv } from '@tests/integration/env';
import { requireLoopbackPostgresUrl } from '@/lib/testing/loopback-postgres-url';

const strip = (file: string) => {
  const sql = readFileSync(new URL(file, import.meta.url), 'utf8');
  if (!/^[\s\S]*?\bbegin;\s*/im.test(sql) || !/\s*commit;\s*$/i.test(sql)) throw new Error(`${file}: transaction wrapper changed`);
  return sql.replace(/^begin;\s*/im, '').replace(/\s*commit;\s*$/i, '');
};
const chain = [
  './20261005100000_my_leads_housekeeping_tools.sql',
  './20261005100100_my_leads_housekeeping_reassign.sql',
  './20261005110000_acquisition_attempt_outcome_voicemail_not_logged.sql',
  './20261005120000_next_step_schema.sql',
].map(strip);
const migration = strip('./20261005170000_seller_appointment_reminders.sql');
const rollback = strip('../rollbacks/20261005170000_seller_appointment_reminders.sql');
const url = process.env.TEST_SUPABASE_DB_URL ?? loadTestEnv().TEST_SUPABASE_DB_URL;
const MIN = 60_000;
const HOUR = 60 * MIN;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function withDb(fn: (db: Client) => Promise<void>, apply = true) {
  if (!url) throw new Error('Missing TEST_SUPABASE_DB_URL');
  requireLoopbackPostgresUrl(url);
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query('begin');
    for (const file of chain) await db.query(file);
    if (apply) await db.query(migration);
    await db.query("select set_config('sandra.allow_appointment_time_move','on',true)");
    await fn(db);
  } finally { await db.query('rollback').catch(() => {}); await db.end(); }
}

async function world(db: Client, enabled = true) {
  const org = randomUUID(), user = randomUUID();
  await db.query('insert into auth.users(id) values ($1)', [user]);
  await db.query("insert into public.organizations(id,name) values ($1::uuid,'Seller reminders '||$1::text)", [org]);
  await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'owner')", [user, org]);
  if (enabled) await db.query('insert into public.seller_reminder_settings(org_id,enabled) values ($1,true)', [org]);
  let n = 0;
  const lead = async (o: { state?: string; contact?: boolean; firstName?: string | null } = {}) => {
    const property = randomUUID();
    let contact: string | null = null;
    if (o.contact !== false) {
      contact = randomUUID();
      n += 1;
      await db.query('insert into public.contacts(id,org_id,first_name,phone_1,phone_1_type) values ($1,$2,$3,$4,$5)',
        [contact, org, o.firstName === undefined ? 'Sally' : o.firstName, `+181655${String(n).padStart(5, '0')}`, 'mobile']);
    }
    await db.query("insert into public.properties(id,org_id,address,state,status,homeowner_contact_id) values ($1,$2,$3,$4,'new_lead',$5)",
      [property, org, `${property} Main`, o.state ?? 'MO', contact]);
    return { property, contact };
  };
  const appt = async (property: string, dueAt: string | Date, o: { mode?: string; chain?: string; contact?: string | null; status?: string } = {}) => {
    const due = new Date(dueAt);
    const id = randomUUID();
    const chain_ = o.chain ?? randomUUID();
    const r = await db.query(
      `insert into public.tasks(id,org_id,type,status,title,due_at,end_at,assignee_id,created_by,calendar_chain_id,related_property_id,mode,contact_id)
       values ($1,$2,'appointment',$3,'Call seller',$4,$5,$6,$6,$7,$8,$9,$10) returning id,calendar_chain_id`,
      [id, org, o.status ?? 'open', due.toISOString(), new Date(due.getTime() + 15 * MIN).toISOString(), user, chain_, property, o.mode ?? 'phone', o.contact ?? null]);
    return { id: r.rows[0].id as string, chain: r.rows[0].calendar_chain_id as string };
  };
  return { org, user, lead, appt };
}

async function asService<T>(db: Client, fn: () => Promise<T>): Promise<T> {
  await db.query("select set_config('request.jwt.claim.role','service_role',true)");
  try { return await fn(); } finally { await db.query("select set_config('request.jwt.claim.role','',true)").catch(() => {}); }
}
const schedule = (db: Client, horizon = '72 hours', limit = 200, orgs: string[] | null = null) =>
  asService(db, async () => (await db.query('select public.fn_schedule_seller_reminders($1::interval,$2,$3::uuid[]) as r', [horizon, limit, orgs])).rows[0].r as Json);
const claim = (db: Client, limit = 1, orgs: string[] | null = null) =>
  asService(db, async () => (await db.query('select * from public.fn_claim_seller_reminders($1,$2::uuid[])', [limit, orgs])).rows as Json[]);
const finish = (db: Client, id: string, token: string, status: string, o: { reason?: string; message?: string; retry?: string; key?: string } = {}) =>
  asService(db, async () => (await db.query('select public.fn_finish_seller_reminder($1,$2,$3,$4,$5,$6,$7) as ok',
    [id, token, status, o.reason ?? null, o.message ?? null, o.retry ?? null, o.key ?? null])).rows[0].ok as boolean);
const rows = async (db: Client, org: string) => (await db.query('select * from public.seller_appointment_reminders where org_id=$1 order by created_at, id', [org])).rows as Json[];
const byTask = async (db: Client, task: string) => (await db.query('select * from public.seller_appointment_reminders where task_id=$1', [task])).rows[0] as Json | undefined;
const failure = async (db: Client, fn: () => Promise<unknown>) => {
  await db.query('savepoint f');
  try { await fn(); await db.query('release savepoint f'); return null; } catch (e) { await db.query('rollback to savepoint f'); return e as { code?: string; message?: string }; }
};

/** Chicago wall time -> ISO instant, for a date well in the future (rules for 2099 are fixed). */
async function chicago(db: Client, date: string, time: string) {
  return (await db.query("select (($1::date + $2::time) at time zone 'America/Chicago') as t", [date, time])).rows[0].t as Date;
}
// Second Sunday of March 2099 (DST starts 2099-03-08) and a normal winter day.
const DST_DAY = '2099-03-08';
const WINTER_DAY = '2099-01-14';
const horizon = '30000 days';

it('creates the outbox objects with service-only access and no rows', async () => {
  await withDb(async (db) => {
    expect((await db.query('select count(*)::int as n from public.seller_reminder_settings')).rows[0].n).toBe(0);
    expect((await db.query('select count(*)::int as n from public.seller_appointment_reminders')).rows[0].n).toBe(0);
    for (const role of ['anon', 'authenticated'] as const) {
      await db.query('savepoint s');
      await db.query(`set local role ${role}`);
      const errs = [
        await failure(db, () => db.query('select public.fn_schedule_seller_reminders()')),
        await failure(db, () => db.query('select * from public.fn_claim_seller_reminders(1)')),
        await failure(db, () => db.query('select public.fn_finish_seller_reminder($1,$1,$2)', [randomUUID(), 'sent'])),
        await failure(db, () => db.query('select * from public.seller_appointment_reminders')),
        await failure(db, () => db.query('select * from public.seller_reminder_settings')),
      ];
      await db.query('rollback to savepoint s');
      for (const e of errs) expect(e?.code).toBe('42501');
    }
    // service_role without the claim, even with an app-level superuser, is refused by the functions
    expect((await failure(db, () => db.query('select public.fn_schedule_seller_reminders()')))?.code).toBe('42501');
    // service_role can read only the on/off switch
    await db.query('savepoint s');
    await db.query('set local role service_role');
    await db.query('select * from public.seller_reminder_settings');
    const denied = await failure(db, () => db.query('select * from public.seller_appointment_reminders'));
    await db.query('rollback to savepoint s');
    expect(denied?.code).toBe('42501');
  });
});

it('schedules only open phone appointments inside the horizon for enabled orgs', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const off = await world(db, false);
    const { property, contact } = await w.lead();
    const soon = new Date(Date.now() + 20 * HOUR);
    const ok = await w.appt(property, soon, { contact });
    await w.appt(property, soon, { mode: 'in_person' });
    await w.appt(property, new Date(Date.now() + 100 * HOUR));
    const offLead = await off.lead();
    await off.appt(offLead.property, soon);
    // outside the 36h default horizon is not scheduled by the default call
    const none = await asService(db, async () => (await db.query('select public.fn_schedule_seller_reminders() as r')).rows[0].r as Json);
    expect(none.scheduled + none.skipped).toBeLessThanOrEqual(1);
    const rs = (await rows(db, w.org)).filter((r) => r.task_id === ok.id);
    expect(rs).toHaveLength(1);
    expect((await rows(db, off.org))).toHaveLength(0);
    const all = await rows(db, w.org);
    expect(all.every((r) => r.status === 'pending' || r.status === 'skipped')).toBe(true);
    expect(all.some((r) => r.task_id !== ok.id && r.due_at > new Date(Date.now() + 36 * HOUR))).toBe(false);
    // idempotent: a second run inserts nothing new
    const again = await schedule(db);
    expect(again.scheduled + again.skipped).toBe(0);
  });
});

it('falls back to the homeowner contact and records the recipient', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const { property, contact } = await w.lead();
    const t = await w.appt(property, await chicago(db, WINTER_DAY, '14:00'));
    await schedule(db, horizon);
    expect((await byTask(db, t.id))?.contact_id).toBe(contact);
    const other = await w.lead();
    const t2 = await w.appt(property, await chicago(db, WINTER_DAY, '15:00'), { contact: other.contact });
    await schedule(db, horizon);
    expect((await byTask(db, t2.id))?.contact_id).toBe(other.contact);
  });
});

it('computes the morning-of send time in America/Chicago, including across the DST change', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const { property } = await w.lead();
    const cases: Array<[string, string, string, string | null, string | null]> = [
      // day, appointment local time, expected send local time or null, expected skip reason
      [WINTER_DAY, '10:15', '09:00', null, null],
      [WINTER_DAY, '09:20', '08:50', null, null],
      [WINTER_DAY, '08:20', '', 'too_early_for_reminder', null],
      [DST_DAY, '10:15', '09:00', null, null],
      [DST_DAY, '14:00', '09:00', null, null],
    ].map(([d, t, s, r]) => [d, t, s, r, null] as [string, string, string, string | null, string | null]);
    for (const [day, time, expectSend, expectSkip] of cases) {
      const due = await chicago(db, day, time);
      const t = await w.appt(property, due);
      await schedule(db, horizon);
      const r = await byTask(db, t.id);
      if (expectSkip) {
        expect(r?.status).toBe('skipped');
        expect(r?.skip_reason).toBe(expectSkip);
      } else {
        expect(r?.status).toBe('pending');
        const local = (await db.query("select to_char($1::timestamptz at time zone 'America/Chicago','HH24:MI') as t, ($1::timestamptz at time zone 'America/Chicago')::date::text as d", [r?.send_at])).rows[0];
        expect(local.t).toBe(expectSend);
        expect(local.d).toBe(day);
        expect(r?.send_local_date.toISOString?.().slice(0, 10) ?? String(r?.send_local_date)).toContain(day.slice(0, 4));
      }
    }
    // the DST day's 09:00 CDT is 14:00 UTC (the change happened at 02:00)
    const dst = await db.query("select send_at at time zone 'UTC' as u from public.seller_appointment_reminders where org_id=$1 and send_local_date=$2::date order by send_at", [w.org, DST_DAY]);
    expect(new Date(dst.rows[0].u + 'Z').getUTCHours()).toBe(14);
  });
});

it('skips a reminder created too late and clamps a live schedule before the call', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const { property } = await w.lead();
    const due = new Date(Date.now() + 20 * MIN);
    const t = await w.appt(property, due);
    await schedule(db, '2 hours');
    const r = await byTask(db, t.id);
    const hour = Number((await db.query("select extract(hour from ($1::timestamptz - interval '30 minutes') at time zone 'America/Chicago') as h", [due])).rows[0].h);
    expect(r?.status).toBe('skipped');
    expect(r?.skip_reason).toBe(hour < 8 ? 'too_early_for_reminder' : 'created_too_late');
    const later = new Date(Date.now() + 2 * HOUR);
    const t2 = await w.appt(property, later);
    await schedule(db, '5 hours');
    const r2 = await byTask(db, t2.id);
    if (r2?.status === 'pending') expect(new Date(r2.send_at).getTime()).toBeLessThanOrEqual(later.getTime() - 30 * MIN + 1000);
    else expect(r2?.skip_reason).toBe('too_early_for_reminder');
  });
});

it('does not schedule without a recipient or with a recorded STOP / do-not-contact', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const day = await chicago(db, WINTER_DAY, '13:00');
    const noContact = await w.lead({ contact: false });
    const t1 = await w.appt(noContact.property, day);
    const stop = await w.lead();
    const t2 = await w.appt(stop.property, day);
    await db.query("insert into public.consent_events(org_id,contact_id,channel,event_type,source,occurred_at) values ($1,$2,'sms','opt_in_informational','test',now()-interval '2 days')", [w.org, stop.contact]);
    await db.query("insert into public.consent_events(org_id,contact_id,channel,event_type,source,occurred_at) values ($1,$2,'sms','opt_out','test',now()-interval '1 day')", [w.org, stop.contact]);
    const dnc = await w.lead();
    const t3 = await w.appt(dnc.property, day);
    await db.query('update public.contacts set do_not_contact=true where id=$1', [dnc.contact]);
    const optedBackIn = await w.lead();
    const t4 = await w.appt(optedBackIn.property, day);
    await db.query("insert into public.consent_events(org_id,contact_id,channel,event_type,source,occurred_at) values ($1,$2,'sms','opt_out','test',now()-interval '2 days')", [w.org, optedBackIn.contact]);
    await db.query("insert into public.consent_events(org_id,contact_id,channel,event_type,source,occurred_at) values ($1,$2,'sms','opt_in_confirmed','test',now()-interval '1 day')", [w.org, optedBackIn.contact]);
    const consented = await w.lead();
    const t5 = await w.appt(consented.property, day);
    await db.query("insert into public.consent_events(org_id,contact_id,channel,event_type,source,occurred_at) values ($1,$2,'sms','opt_in_informational','test',now())", [w.org, consented.contact]);
    await schedule(db, horizon);
    expect([(await byTask(db, t1.id))?.skip_reason, (await byTask(db, t2.id))?.skip_reason, (await byTask(db, t3.id))?.skip_reason]).toEqual(['no_contact', 'opted_out', 'opted_out']);
    for (const t of [t1, t2, t3]) expect((await byTask(db, t.id))?.status).toBe('skipped');
    for (const t of [t4, t5]) expect((await byTask(db, t.id))?.status).toBe('pending');
  });
});

it('cancels pending rows when the task is rescheduled, cancelled, completed or flipped to in person; the successor gets its own row', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const { property } = await w.lead();
    const day = await chicago(db, WINTER_DAY, '13:00');
    const chainA = randomUUID();
    const reschedA = await w.appt(property, day, { chain: chainA });
    const cancelled = await w.appt(property, day);
    const done = await w.appt(property, day);
    const flipped = await w.appt(property, day);
    const moved = await w.appt(property, day);
    await schedule(db, horizon);
    for (const t of [reschedA, cancelled, done, flipped, moved]) expect((await byTask(db, t.id))?.status).toBe('pending');
    // reschedule = old task closed, successor in the same chain
    await db.query("update public.tasks set status='cancelled', outcome='rescheduled' where id=$1", [reschedA.id]);
    const successor = await w.appt(property, await chicago(db, WINTER_DAY, '15:00'), { chain: chainA });
    await db.query("update public.tasks set status='cancelled', outcome='cancelled' where id=$1", [cancelled.id]);
    await db.query("update public.tasks set status='completed', outcome='held' where id=$1", [done.id]);
    await db.query("update public.tasks set mode='in_person' where id=$1", [flipped.id]);
    await db.query("update public.tasks set due_at=due_at + interval '1 hour', end_at=end_at + interval '1 hour' where id=$1", [moved.id]);
    const r = await schedule(db, horizon);
    expect(r.cancelledTaskChanged).toBe(5);
    for (const t of [reschedA, cancelled, done, flipped, moved]) {
      const row = await byTask(db, t.id);
      expect([row?.status, row?.skip_reason]).toEqual(['cancelled', 'task_changed']);
    }
    expect((await byTask(db, successor.id))?.status).toBe('pending');
  });
});

it('cancels pending and claimed rows of an org that is disabled, and never claims a disabled org', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const { property } = await w.lead();
    const t = await w.appt(property, await chicago(db, WINTER_DAY, '13:00'));
    await schedule(db, horizon);
    await db.query("update public.seller_appointment_reminders set send_at=now()-interval '1 minute' where task_id=$1", [t.id]);
    await db.query('update public.seller_reminder_settings set enabled=false where org_id=$1', [w.org]);
    expect(await claim(db)).toHaveLength(0);
    expect((await byTask(db, t.id))?.status).toBe('pending');
    const r = await schedule(db, horizon);
    expect(r.cancelledDisabled).toBe(1);
    expect(await byTask(db, t.id)).toMatchObject({ status: 'cancelled', skip_reason: 'reminders_disabled' });
  });
});

async function claimable(db: Client, w: Awaited<ReturnType<typeof world>>, label = 'x') {
  const { property } = await w.lead({ firstName: label });
  const t = await w.appt(property, await chicago(db, WINTER_DAY, '13:00'));
  await schedule(db, horizon);
  await db.query("update public.seller_appointment_reminders set send_at=now()-interval '1 minute' where task_id=$1", [t.id]);
  return t;
}

it('claims with a lease: p_limit, fencing, stale reclaim after 10 minutes, stale at 3 attempts is uncertain', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const a = await claimable(db, w, 'a');
    const b = await claimable(db, w, 'b');
    const c = await claimable(db, w, 'c');
    const first = await claim(db, 2);
    expect(first).toHaveLength(2);
    expect(first[0]).toMatchObject({ property_state: 'MO', task_mode: 'phone', task_status: 'open' });
    expect(first[0].attempts).toBe(1);
    expect(first[0].send_key).toMatch(/^[0-9a-f-]{36}$/);
    expect(first[0].contact_first_name).toBeTruthy();
    expect(await claim(db, 5)).toHaveLength(1); // only the third is left; claimed ones are leased
    expect(await claim(db, 5)).toHaveLength(0);
    // stale token cannot finish; the current one can
    const row = first[0];
    expect(await finish(db, row.id, randomUUID(), 'sent')).toBe(false);
    expect(await finish(db, row.id, row.claim_token, 'sent', { reason: null as unknown as string })).toBe(true);
    expect(await finish(db, row.id, row.claim_token, 'sent')).toBe(false);
    // stale lease after 10 minutes is reclaimed with the SAME key
    const other = first[1];
    await db.query("update public.seller_appointment_reminders set claimed_at=now()-interval '11 minutes' where id=$1", [other.id]);
    const re = await claim(db, 5);
    expect(re.map((r) => r.id)).toContain(other.id);
    const again = re.find((r) => r.id === other.id);
    expect(again.send_key).toBe(other.send_key);
    expect(again.attempts).toBe(2);
    expect(again.claim_token).not.toBe(other.claim_token);
    expect(await finish(db, other.id, other.claim_token, 'sent')).toBe(false); // old token fenced out
    // a stale lease that already used 3 attempts may have sent: terminal and never selected
    await db.query("update public.seller_appointment_reminders set claimed_at=now()-interval '11 minutes', attempts=3 where id=$1", [other.id]);
    expect(await claim(db, 5)).toHaveLength(0);
    expect(await byTask(db, [a, b, c].map((t) => t.id).find((id) => id === other.task_id)!)).toMatchObject({ status: 'uncertain', skip_reason: 'unknown_delivery' });
  });
});

it('allows only one send per appointment per Chicago day', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const { property } = await w.lead();
    const day = await chicago(db, WINTER_DAY, '13:00');
    const chainId = randomUUID();
    const t1 = await w.appt(property, day, { chain: chainId });
    await schedule(db, horizon);
    await db.query("update public.seller_appointment_reminders set send_at=now()-interval '1 minute' where task_id=$1", [t1.id]);
    const [c1] = await claim(db);
    expect(await finish(db, c1.id, c1.claim_token, 'sent', { message: null as unknown as string })).toBe(true);
    // reschedule inside the same day: the successor is scheduled, but its claim cannot become a second send
    await db.query("update public.tasks set status='cancelled', outcome='rescheduled' where id=$1", [t1.id]);
    const t2 = await w.appt(property, await chicago(db, WINTER_DAY, '16:00'), { chain: chainId });
    await schedule(db, horizon);
    await db.query("update public.seller_appointment_reminders set send_at=now()-interval '1 minute' where task_id=$1", [t2.id]);
    const direct = await failure(db, () => db.query("insert into public.seller_appointment_reminders(org_id,task_id,calendar_chain_id,property_id,due_at,send_at,send_local_date,status) select org_id,task_id,calendar_chain_id,property_id,due_at,send_at,send_local_date,'sent' from public.seller_appointment_reminders where task_id=$1 on conflict do nothing", [t2.id]));
    expect(direct).toBeNull();
    // the claim path: t1's row is already `sent` for that chain/day, so t2's claim is converted to a skip
    const claimed = await claim(db);
    expect(claimed).toHaveLength(0);
    expect(await byTask(db, t2.id)).toMatchObject({ status: 'skipped', skip_reason: 'duplicate_for_appointment_day' });
  });
});

it('finishes with retry semantics: new key on provider retry, third failure is final, deferral gives the attempt back, uncertain is never reclaimed', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const t = await claimable(db, w);
    const key = (await byTask(db, t.id))!.send_key as string;
    const retryAt = () => new Date(Date.now() - MIN).toISOString();
    const newKey = () => randomUUID();

    // deferral (quiet hours): no key, attempt handed back
    let [c] = await claim(db);
    expect(c.attempts).toBe(1);
    expect(await finish(db, c.id, c.claim_token, 'pending', { reason: 'quiet_hours', retry: retryAt() })).toBe(true);
    expect(await byTask(db, t.id)).toMatchObject({ status: 'pending', attempts: 0, send_key: key });

    // definitive failure: fresh key, claim again
    [c] = await claim(db);
    const k1 = newKey();
    expect(await finish(db, c.id, c.claim_token, 'pending', { reason: 'provider_failed', retry: retryAt(), key: k1 })).toBe(true);
    expect(await byTask(db, t.id)).toMatchObject({ status: 'pending', attempts: 1, send_key: k1 });
    [c] = await claim(db);
    expect(c.send_key).toBe(k1);
    const k2 = newKey();
    expect(await finish(db, c.id, c.claim_token, 'pending', { retry: retryAt(), key: k2 })).toBe(true);
    [c] = await claim(db);
    expect(c.attempts).toBe(3);
    // third failed attempt is final and keeps its key
    expect(await finish(db, c.id, c.claim_token, 'pending', { reason: 'provider_failed', retry: retryAt(), key: newKey() })).toBe(true);
    expect(await byTask(db, t.id)).toMatchObject({ status: 'failed', send_key: k2 });
    expect(await claim(db)).toHaveLength(0);

    // validation: pending needs a retry time; a new key is only for pending; non-v4 key refused by the column
    const t2 = await claimable(db, w, 'two');
    [c] = await claim(db);
    expect((await failure(db, () => finish(db, c.id, c.claim_token, 'pending')))?.code).toBe('22023');
    expect((await failure(db, () => finish(db, c.id, c.claim_token, 'sent', { key: newKey() })))?.code).toBe('22023');
    expect((await failure(db, () => finish(db, c.id, c.claim_token, 'bogus')))?.code).toBe('22023');
    await db.query('savepoint s');
    const bad = await failure(db, () => db.query("update public.seller_appointment_reminders set send_key='00000000-0000-1000-8000-000000000000' where id=$1", [c.id]));
    await db.query('rollback to savepoint s');
    expect(bad?.code).toBe('23514');
    // uncertain is final and never reclaimed, even after the lease window
    expect(await finish(db, c.id, c.claim_token, 'uncertain', { reason: 'unknown_delivery' })).toBe(true);
    await db.query("update public.seller_appointment_reminders set claimed_at=now()-interval '1 hour' where task_id=$1", [t2.id]);
    expect(await claim(db)).toHaveLength(0);
    expect((await byTask(db, t2.id))?.status).toBe('uncertain');
  });
});

it('leaves the rep reminder sweep alone: no tasks column is written and the claim functions still exist', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const { property } = await w.lead();
    const t = await w.appt(property, await chicago(db, WINTER_DAY, '13:00'));
    const before = (await db.query('select reminder_claimed_at, updated_at from public.tasks where id=$1', [t.id])).rows[0];
    await schedule(db, horizon);
    await db.query("update public.seller_appointment_reminders set send_at=now()-interval '1 minute' where task_id=$1", [t.id]);
    await claim(db);
    expect((await db.query('select reminder_claimed_at, updated_at from public.tasks where id=$1', [t.id])).rows[0]).toEqual(before);
    expect((await db.query("select to_regprocedure('public.fn_claim_appointment_reminders(integer)') is not null as ok")).rows[0].ok).toBe(true);
  });
});

it('rolls back cleanly and ships no data step', async () => {
  await withDb(async (db) => {
    const sql = readFileSync(new URL('./20261005170000_seller_appointment_reminders.sql', import.meta.url), 'utf8');
    expect(sql).not.toMatch(/insert into public\.seller_reminder_settings|insert into public\.my_leads_feature_flags|update public\.my_leads_feature_flags/i);
    await db.query(rollback);
    expect((await db.query("select to_regclass('public.seller_appointment_reminders') is null as gone")).rows[0].gone).toBe(true);
    expect((await db.query("select to_regprocedure('public.fn_claim_seller_reminders(integer,uuid[])') is null as gone")).rows[0].gone).toBe(true);
  });
});
