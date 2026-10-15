import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { expect, it } from 'vitest';
import { loadTestEnv } from '@tests/integration/env';
import { requireLoopbackPostgresUrl } from '@/lib/testing/loopback-postgres-url';

// My Leads unified queue, Phase B1: the no-expiry "Call today" pin (fn_set_my_leads_pin), the widened
// check constraint, and Dismiss on a Broken row (fn_dismiss_my_leads_broken). The database must already hold the
// repo's migrations; the local disposable stack may lag, so this suite also replays the classifier and flag
// migrations when they are missing, and always re-applies its own migration, all inside a rolled-back transaction.
const read = (file: string) => {
  const sql = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
  if (!/^[\s\S]*?\bbegin;\s*/im.test(sql) || !/\s*commit;\s*$/i.test(sql)) throw new Error(`transaction wrapper changed in ${file}`);
  return sql.replace(/^begin;\s*/im, '').replace(/\s*commit;\s*$/i, '');
};
const classifierSql = read('20261015010000_my_leads_work_queue_classifier.sql');
const flagSql = read('20261015020000_my_leads_unified_queue_flag.sql');
const migrationSql = read('20261015020100_my_leads_pin_no_expiry.sql');
const rollbackSql = (() => {
  const sql = readFileSync(new URL('../rollbacks/20261015020100_my_leads_pin_no_expiry.sql', import.meta.url), 'utf8');
  if (!/\bbegin;/i.test(sql) || !/commit;\s*$/i.test(sql)) throw new Error('transaction wrapper changed in the rollback');
  return sql.replace(/^[\s\S]*?\bbegin;\s*/i, '').replace(/\s*commit;\s*$/i, '');
})();
const url = process.env.TEST_SUPABASE_DB_URL ?? loadTestEnv().TEST_SUPABASE_DB_URL;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function withDb(fn: (db: Client) => Promise<void>) {
  if (!url) throw new Error('Missing TEST_SUPABASE_DB_URL');
  requireLoopbackPostgresUrl(url);
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query('begin');
    const hasClassifier = (await db.query("select to_regprocedure('public.fn_my_leads_work_page(uuid,uuid,text,text,text,text,integer,integer,timestamptz)') as f")).rows[0].f;
    if (!hasClassifier) await db.query(classifierSql);
    await db.query(flagSql);
    await db.query(migrationSql);
    await fn(db);
  } finally { await db.query('rollback').catch(() => {}); await db.end(); }
}

async function world(db: Client) {
  const org = randomUUID(), owner = randomUUID(), sam = randomUUID(), other = randomUUID(), outsider = randomUUID();
  for (const id of [owner, sam, other, outsider]) await db.query('insert into auth.users(id) values ($1)', [id]);
  await db.query("insert into public.organizations(id,name) values ($1,'Pin queue')", [org]);
  await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'owner')", [owner, org]);
  for (const id of [sam, other]) await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'member')", [id, org]);
  const org2 = randomUUID();
  await db.query("insert into public.organizations(id,name) values ($1,'Other org')", [org2]);
  await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'owner')", [outsider, org2]);
  await db.query('insert into public.acquisition_org_settings(org_id,my_leads_enabled,needs_sequence_owner_id) values ($1,true,$2)', [org, owner]);
  await db.query('insert into public.acquisition_org_settings(org_id,my_leads_enabled,needs_sequence_owner_id) values ($1,true,$2)', [org2, outsider]);
  await db.query("select set_config('request.jwt.claim.sub',$1,true)", [owner]);
  for (const id of [owner, sam, other]) {
    await db.query("select set_config('my_leads.designation_update',$1,true)", [`${owner}:${org}:${id}`]);
    await db.query('update public.memberships set acquisitions_enabled=true where user_id=$1 and org_id=$2', [id, org]);
  }
  await db.query("select set_config('my_leads.designation_update','',true)");
  await db.query("select set_config('request.jwt.claim.sub','',true)");

  let phoneSeq = 0;
  const raw = async (sql: string, params: unknown[]) => {
    await db.query("set local session_replication_role='replica'");
    try { await db.query(sql, params); } catch (error) { await db.query('rollback'); throw error; }
    await db.query("set local session_replication_role='origin'");
  };
  const attempt = (property: string, when: string) => raw(
    "insert into public.acquisition_attempts(org_id,property_id,actor_user_id,attempt_kind,source,occurred_at,recorded_at,idempotency_key,outcome) values ($1,$2,$3,'outreach','manual',$4,$4,$5,'no_answer')",
    [org, property, sam, when, randomUUID()]);
  const lead = async (key: string, assignee = sam) => {
    const id = randomUUID(), contact = randomUUID();
    phoneSeq += 1;
    await db.query('insert into public.contacts(id,org_id,first_name,last_name,phone_1,phone_1_type) values ($1,$2,$3,$4,$5,$6)', [contact, org, key, 'Lead', `+181655${String(phoneSeq).padStart(5, '0')}`, 'mobile']);
    await db.query("insert into public.properties(id,org_id,address,state,status,assigned_user_id,homeowner_contact_id) values ($1,$2,$3,'MO','new_lead',$4,$5)", [id, org, `${key} Main`, assignee, contact]);
    // Worked once a month ago, so it is not a brand-new lead by accident.
    await attempt(id, new Date(Date.now() - 30 * DAY).toISOString());
    return id;
  };
  const ledger = async (property: string, state: string, updated: string) => {
    const contact = (await db.query('select homeowner_contact_id as c from public.properties where id=$1', [property])).rows[0].c;
    const id = randomUUID();
    await raw(
      `insert into public.rep_sms_delivery_ledger(id,org_id,actor_user_id,submission_key,property_id,contact_id,sender_assignment_id,provider,provider_account_id,provider_sender_id,from_number,to_number,body,state,claim_token,message_id,created_at,updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,'sendillo','acct','sender','+18165550100','+18165550101','hi',$8,$9,null,$10,$10)`,
      [id, org, sam, randomUUID(), property, contact, randomUUID(), state, randomUUID(), updated]);
    return id;
  };
  const as = async <T,>(role: 'authenticated' | 'anon', sub: string | null, run: () => Promise<T>) => {
    await db.query(`set local role ${role}`);
    await db.query("select set_config('request.jwt.claim.role',$1,true)", [role]);
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [sub ?? '']);
    try { return await run(); } finally { await db.query('reset role').catch(() => {}); }
  };
  const expectError = async (run: () => Promise<unknown>, pattern: RegExp) => {
    await db.query('savepoint s');
    let failure: unknown = null;
    try { await run(); } catch (error) { failure = error; }
    await db.query('rollback to savepoint s');
    await db.query('reset role');
    expect(String((failure as Error)?.message)).toMatch(pattern);
  };
  const pin = (sub: string, property: string, action: string, o: { member?: string; orgId?: string } = {}) =>
    as('authenticated', sub, async () => (await db.query('select public.fn_set_my_leads_pin($1,$2,$3,$4) as r', [o.orgId ?? org, o.member ?? sam, property, action])).rows[0].r as Json);
  const dismiss = (sub: string, property: string, source: string | null, o: { member?: string; orgId?: string } = {}) =>
    as('authenticated', sub, async () => (await db.query('select public.fn_dismiss_my_leads_broken($1,$2,$3,$4) as r', [o.orgId ?? org, o.member ?? sam, property, source])).rows[0].r as Json);
  const overrides = async (property: string) => (await db.query('select * from public.my_leads_strip_overrides where property_id=$1 and member_id=$2', [property, sam])).rows;
  const dismissEvents = async (source: string) => (await db.query("select * from public.lead_events where event_type='rep_sms_failure_dismissed' and source_id=$1", [source])).rows;
  const classified = async (property: string, when: Date): Promise<Json> =>
    (await db.query('select * from public.my_leads_work_classified($1,$2,$3) where property_id=$4', [org, sam, when.toISOString(), property])).rows[0];
  return { org, org2, owner, sam, other, outsider, lead, ledger, attempt, as, expectError, pin, dismiss, overrides, dismissEvents, classified, raw };
}

it('the unified_queue flag column exists and defaults to false', async () => {
  await withDb(async (db) => {
    const col = (await db.query("select data_type, column_default, is_nullable from information_schema.columns where table_schema='public' and table_name='my_leads_feature_flags' and column_name='unified_queue'")).rows[0];
    expect(col).toMatchObject({ data_type: 'boolean', is_nullable: 'NO' });
    expect(col.column_default).toBe('false');
  });
});

it('the check constraint accepts a no-expiry pin and still rejects both-null and both-set rows', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const [a, b, c, d, e, f] = [await w.lead('a'), await w.lead('b'), await w.lead('c'), await w.lead('d'), await w.lead('e'), await w.lead('f')];
    const ins = (property: string, pinnedAt: string | null, pinnedUntil: string | null, hiddenUntil: string | null) =>
      () => db.query('insert into public.my_leads_strip_overrides(org_id,member_id,property_id,pinned_at,pinned_until,hidden_until) values ($1,$2,$3,$4,$5,$6)', [w.org, w.sam, property, pinnedAt, pinnedUntil, hiddenUntil]);
    const now = new Date().toISOString(), later = new Date(Date.now() + HOUR).toISOString();
    await ins(a, now, null, null)();             // no-expiry pin (new)
    await ins(b, now, later, null)();            // expiring pin (old)
    await ins(c, null, null, later)();           // Not today (old)
    expect(await w.overrides(a)).toHaveLength(1);
    await w.expectError(ins(d, null, null, null), /^new row for relation "my_leads_strip_overrides" violates check constraint "my_leads_strip_overrides_one_kind_check"$/);   // both expiries null, no pin
    await w.expectError(ins(d, now, later, later), /^new row for relation "my_leads_strip_overrides" violates check constraint "my_leads_strip_overrides_one_kind_check"$/);  // both expiries set
    await w.expectError(ins(e, null, later, null), /^new row for relation "my_leads_strip_overrides" violates check constraint "my_leads_strip_overrides_one_kind_check"$/);  // expiring pin without a pin timestamp
    await w.expectError(ins(f, now, null, later), /^new row for relation "my_leads_strip_overrides" violates check constraint "my_leads_strip_overrides_one_kind_check"$/);   // pin timestamp with a hide expiry
  });
});

it('fn_set_my_leads_pin: pin stamps pinned_at with no expiry, repeats, and clear removes it', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const id = await w.lead('p');
    const first = await w.pin(w.sam, id, 'pin');
    expect(first.ok).toBe(true);
    expect(new Date(first.pinnedAt).getTime()).toBeGreaterThan(Date.now() - MIN);
    const rows = await w.overrides(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].pinned_until).toBeNull();
    expect(rows[0].hidden_until).toBeNull();
    expect(new Date(rows[0].pinned_at).toISOString()).toBe(new Date(first.pinnedAt).toISOString());
    const second = await w.pin(w.sam, id, 'pin');
    expect(new Date(second.pinnedAt).getTime()).toBeGreaterThanOrEqual(new Date(first.pinnedAt).getTime());
    expect(await w.overrides(id)).toHaveLength(1);
    const cleared = await w.pin(w.sam, id, 'clear');
    expect(cleared).toEqual({ ok: true, pinnedAt: null });
    expect(await w.overrides(id)).toHaveLength(0);
    expect(await w.pin(w.sam, id, 'clear')).toEqual({ ok: true, pinnedAt: null });   // clearing nothing is fine
  });
});

it('fn_set_my_leads_pin: validates input and is member-only', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const mine = await w.lead('mine');
    const theirs = await w.lead('theirs', w.other);
    await w.expectError(() => w.pin(w.sam, mine, 'snooze'), /^INVALID_INPUT$/);
    await w.expectError(() => w.pin(w.sam, mine, null as unknown as string), /^INVALID_INPUT$/);
    await w.expectError(() => w.pin(w.sam, randomUUID(), 'pin'), /^NOT_FOUND$/);
    await w.expectError(() => w.pin(w.sam, theirs, 'pin'), /^NOT_FOUND$/);                       // a lead in someone else's queue
    await w.expectError(() => w.pin(w.owner, mine, 'pin'), /^FORBIDDEN$/);                       // owner viewing a rep's queue may read, not write
    await w.expectError(() => w.pin(w.other, mine, 'pin'), /^FORBIDDEN$/);             // another rep, same org
    await w.expectError(() => w.pin(w.outsider, mine, 'pin'), /^FORBIDDEN$/);          // other org, this org's id
    await w.expectError(() => w.pin(w.outsider, mine, 'pin', { member: w.outsider, orgId: w.org2 }), /^NOT_FOUND$/);   // other org, its own id: the lead is not theirs
    await w.expectError(() => w.as('anon', null, async () => db.query('select public.fn_set_my_leads_pin($1,$2,$3,$4)', [w.org, w.sam, mine, 'pin'])), /^permission denied for function fn_(set_my_leads_pin|dismiss_my_leads_broken)$/);
    expect(await w.overrides(mine)).toHaveLength(0);
    expect(await w.overrides(theirs)).toHaveLength(0);
  });
});

it('a no-expiry pin survives the old strip override cleanup and the old call-next read ignores it', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const pinned = await w.lead('pinned');
    const other = await w.lead('other');
    await w.pin(w.sam, pinned, 'pin');
    // The old RPC deletes expired rows before it writes; a no-expiry pin must not count as expired.
    await w.as('authenticated', w.sam, async () => db.query('select public.fn_set_my_leads_strip_override($1,$2,$3,$4)', [w.org, w.sam, other, 'call_today']));
    expect(await w.overrides(pinned)).toHaveLength(1);
    expect((await w.overrides(pinned))[0].pinned_until).toBeNull();
    // Flag-off page: pinned_until is null, so "pinned_until > now" is not true; the lead is an ordinary row.
    const rows = (await db.query('select property_id, pinned, reason from public.my_leads_call_next_rows($1,$2,$3)', [w.org, w.sam, new Date().toISOString()])).rows;
    const mine = rows.find((r) => r.property_id === pinned);
    expect(mine).toBeTruthy();
    expect(mine.pinned).toBe(false);
    expect(mine.reason).not.toBe('pinned_call_today');
    expect(rows.find((r) => r.property_id === other)?.pinned).toBe(true);   // the old expiring pin still works
  });
});

it('the classifier shows a pinned lead as call_today, and a later call attempt ends it', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const id = await w.lead('cls');
    const before = await w.classified(id, new Date(Date.now() + HOUR));
    expect(before.reason).not.toBe('call_today');
    const { pinnedAt } = await w.pin(w.sam, id, 'pin');
    const after = await w.classified(id, new Date(Date.now() + HOUR));
    expect({ place: after.place, reason: after.reason, row: after.row_no }).toEqual({ place: 'your_move', reason: 'call_today', row: '2' });
    expect(new Date(after.reason_at).toISOString()).toBe(new Date(pinnedAt).toISOString());
    await w.attempt(id, new Date(new Date(pinnedAt).getTime() + 10 * MIN).toISOString());
    const called = await w.classified(id, new Date(Date.now() + HOUR));
    expect(called.reason).not.toBe('call_today');
    expect(called.row_no).not.toBe('2');
  });
});

it('fn_dismiss_my_leads_broken writes exactly one rep_sms_failure_dismissed event, idempotently, and clears the Broken row', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const id = await w.lead('brk');
    const ledgerId = await w.ledger(id, 'blocked', new Date(Date.now() - HOUR).toISOString());
    const at = new Date(Date.now() + MIN);
    const broken = await w.classified(id, at);
    expect(broken.reason).toBe('broken');
    expect(broken.facts.broken.map((b: Json) => b.refId)).toContain(ledgerId);
    expect(await w.dismiss(w.sam, id, ledgerId)).toEqual({ ok: true });
    let events = await w.dismissEvents(ledgerId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor_type: 'user', actor_id: w.sam, event_type: 'rep_sms_failure_dismissed', property_id: id, org_id: w.org, source_id: ledgerId });
    expect(await w.dismiss(w.sam, id, ledgerId)).toEqual({ ok: true });   // repeating is a no-op
    events = await w.dismissEvents(ledgerId);
    expect(events).toHaveLength(1);
    const cleared = await w.classified(id, new Date(Date.now() + MIN));
    expect(cleared.reason).not.toBe('broken');
    expect(cleared.facts.broken).toEqual([]);
  });
});

it('fn_dismiss_my_leads_broken: input checks, member-only, cross-org negatives, no stray writes', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const mine = await w.lead('mine');
    const theirs = await w.lead('theirs', w.other);
    const src = randomUUID();
    const mineLedger = await w.ledger(mine, 'blocked', new Date(Date.now() - HOUR).toISOString());
    const theirLedger = await w.ledger(theirs, 'blocked', new Date(Date.now() - HOUR).toISOString());
    await w.expectError(() => w.dismiss(w.sam, mine, null), /^INVALID_INPUT$/);
    await w.expectError(() => w.dismiss(w.sam, mine, src), /^NOT_FOUND$/);                     // an id that is no Broken source at all
    await w.expectError(() => w.dismiss(w.sam, mine, theirLedger), /^NOT_FOUND$/);             // another lead's ledger id, even in the same org
    await w.expectError(() => w.dismiss(w.sam, mine, mine), /^NOT_FOUND$/);                    // a lead id is not a source id
    await w.expectError(() => w.dismiss(w.sam, null as unknown as string, src), /^INVALID_INPUT$/);
    await w.expectError(() => w.dismiss(w.sam, randomUUID(), src), /^NOT_FOUND$/);
    await w.expectError(() => w.dismiss(w.sam, theirs, src), /^NOT_FOUND$/);
    await w.expectError(() => w.dismiss(w.owner, mine, src), /^FORBIDDEN$/);
    await w.expectError(() => w.dismiss(w.other, mine, src), /^FORBIDDEN$/);
    await w.expectError(() => w.dismiss(w.outsider, mine, src), /^FORBIDDEN$/);
    await w.expectError(() => w.dismiss(w.outsider, mine, src, { member: w.outsider, orgId: w.org2 }), /^NOT_FOUND$/);
    await w.expectError(() => w.as('anon', null, async () => db.query('select public.fn_dismiss_my_leads_broken($1,$2,$3,$4)', [w.org, w.sam, mine, src])), /^permission denied for function fn_(set_my_leads_pin|dismiss_my_leads_broken)$/);
    for (const id of [src, theirLedger, mine]) expect(await w.dismissEvents(id)).toHaveLength(0);
    expect(await w.dismiss(w.sam, mine, mineLedger)).toEqual({ ok: true });                    // its own source still works
  });
});

it('rollback round trip: up, down, up leaves the old function, check and pins behaving, then restores the new ones', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const id = await w.lead('rt');
    const fn = (name: string) => db.query(`select to_regprocedure('${name}') as f`).then((r) => r.rows[0].f);
    const NEW = ['public.fn_set_my_leads_pin(uuid,uuid,uuid,text)', 'public.fn_dismiss_my_leads_broken(uuid,uuid,uuid,uuid)'];
    for (const f of NEW) expect(await fn(f)).not.toBeNull();
    await w.pin(w.sam, id, 'pin');
    expect(await w.overrides(id)).toHaveLength(1);

    // down
    await db.query(rollbackSql);
    for (const f of NEW) expect(await fn(f)).toBeNull();
    expect(await w.overrides(id)).toHaveLength(0);                                              // the no-expiry pin was removed
    const noExpiry = () => db.query('insert into public.my_leads_strip_overrides(org_id,member_id,property_id,pinned_at) values ($1,$2,$3,now())', [w.org, w.sam, id]);
    await w.expectError(noExpiry, /^new row for relation "my_leads_strip_overrides" violates check constraint "my_leads_strip_overrides_one_kind_check"$/);
    const old = await w.as('authenticated', w.sam, async () => (await db.query('select public.fn_set_my_leads_strip_override($1,$2,$3,$4) as r', [w.org, w.sam, id, 'call_today'])).rows[0].r as Json);
    expect(old.ok).toBe(true);
    expect(await w.overrides(id)).toHaveLength(1);
    expect((await w.overrides(id))[0].pinned_until).not.toBeNull();                              // the old midnight-expiring pin works again

    // up again
    await db.query(migrationSql);
    for (const f of NEW) expect(await fn(f)).not.toBeNull();
    expect((await w.pin(w.sam, id, 'pin')).ok).toBe(true);
    const row = (await w.overrides(id))[0];
    expect(row.pinned_until).toBeNull();
    const ledgerId = await w.ledger(id, 'blocked', new Date(Date.now() - HOUR).toISOString());
    expect(await w.dismiss(w.sam, id, ledgerId)).toEqual({ ok: true });
    await w.expectError(() => w.dismiss(w.sam, id, randomUUID()), /^NOT_FOUND$/);
  });
});
