import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { expect, it } from 'vitest';
import { loadTestEnv } from '@tests/integration/env';
import { requireLoopbackPostgresUrl } from '@/lib/testing/loopback-postgres-url';
import { applyMyLeadsChain } from '@tests/integration/my-leads-housekeeping-fixture';

const url = process.env.TEST_SUPABASE_DB_URL ?? loadTestEnv().TEST_SUPABASE_DB_URL;

type Role = 'authenticated' | 'anon' | 'service_role';
const hours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

async function withWorld(fn: (w: Awaited<ReturnType<typeof world>>) => Promise<void>) {
  if (!url) throw new Error('Missing TEST_SUPABASE_DB_URL');
  requireLoopbackPostgresUrl(url);
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query('begin');
    await applyMyLeadsChain(db, ['schema', 'createFn', 'replayLocation']);
    await fn(await world(db));
  } finally {
    await db.query('rollback').catch(() => {});
    await db.end();
  }
}

async function world(db: Client) {
  const org = randomUUID(), jarrad = randomUUID(), sam = randomUUID(), outsider = randomUUID();
  for (const id of [jarrad, sam, outsider]) await db.query('insert into auth.users(id) values ($1)', [id]);
  await db.query("insert into public.organizations(id,name) values ($1,'Create next step')", [org]);
  await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'owner')", [jarrad, org]);
  await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'member')", [sam, org]);
  await db.query('insert into public.acquisition_org_settings(org_id,my_leads_enabled) values ($1,true)', [org]);
  const prop = async (status = 'new_lead', extra = '') => {
    const id = randomUUID();
    await db.query(`insert into public.properties(id,org_id,address,state,status,assigned_user_id) values ($1,$2,$3,'MO',$4,$5)`, [id, org, `${id.slice(0, 6)} Main`, status, jarrad]);
    if (extra) {
      await db.query("set local session_replication_role='replica'");
      await db.query(`update public.properties set ${extra} where id=$1`, [id]);
      await db.query("set local session_replication_role='origin'");
    }
    return id;
  };
  const property = await prop();
  const as = async <T,>(role: Role, sub: string | null, run: () => Promise<T>) => {
    await db.query(`set local role ${role}`);
    await db.query("select set_config('request.jwt.claim.role',$1,true)", [role]);
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [sub ?? '']);
    try { return await run(); } finally { await db.query('reset role').catch(() => {}); }
  };
  const call = (args: Record<string, unknown>, role: Role = 'service_role', sub: string | null = null) => {
    if (role === 'authenticated' && !('p_enforce_window' in args)) args = { ...args, p_enforce_window: true };
    const keys = Object.keys(args);
    const sql = `select public.fn_create_next_step(${keys.map((k, i) => `${k} => $${i + 1}`).join(',')}) as r`;
    return as(role, sub, async () => (await db.query(sql, keys.map((k) => args[k]))).rows[0].r);
  };
  const base = (extra: Record<string, unknown> = {}) => ({
    p_org: org, p_actor: jarrad, p_assignee: jarrad, p_kind: 'appointment', p_title: 'Call back seller',
    p_due_at: hours(24), p_property: property, ...extra,
  });
  const expectError = async (run: () => Promise<unknown>, pattern: RegExp) => {
    await db.query('savepoint s');
    let failure: unknown = null;
    try { await run(); } catch (error) { failure = error; }
    await db.query('rollback to savepoint s');
    await db.query('reset role');
    expect(String((failure as Error)?.message)).toMatch(pattern);
  };
  const row = async (id: string) => (await db.query('select * from public.tasks where id=$1', [id])).rows[0];
  const events = async (id: string) => (await db.query('select * from public.lead_events where source_id=$1 order by created_at', [id])).rows;
  const attribution = async (id: string) => (await db.query('select * from public.acquisition_appointment_attribution where task_id=$1', [id])).rows;
  const ledger = async (id: string) => (await db.query('select * from public.task_calendar_mutations where source_task_id=$1', [id])).rows;
  return { db, org, jarrad, sam, outsider, property, prop, as, call, base, expectError, row, events, attribution, ledger };
}

it('creates a phone appointment: 15 minutes, chain, attribution, event, no calendar ledger', async () => {
  await withWorld(async (w) => {
    const due = hours(24);
    const r = await w.call(w.base({ p_due_at: due, p_description: 'about the roof' }), 'authenticated', w.jarrad);
    expect(r).toMatchObject({ duplicate: false, converted: false, kind: 'appointment', mode: 'phone', ledger_id: null, related_property_id: w.property });
    expect(r.calendar_chain_id).toBeTruthy();
    const t = await w.row(r.task_id);
    expect(t).toMatchObject({ type: 'appointment', mode: 'phone', status: 'open', next_step_kind: 'appointment', created_by: w.jarrad, assignee_id: w.jarrad, location: null });
    expect(new Date(t.end_at).getTime() - new Date(t.due_at).getTime()).toBe(900_000);
    expect(t.calendar_chain_id).toBe(r.calendar_chain_id);
    expect(await w.ledger(r.task_id)).toHaveLength(0);
    expect(await w.attribution(r.task_id)).toMatchObject([{ accountable_user_id: w.jarrad, source: 'booking_insert' }]);
    const ev = await w.events(r.task_id);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ event_type: 'appointment_booked', source_type: 'appointments.booked', actor_type: 'user', actor_id: w.jarrad, property_id: w.property });
    expect(ev[0].payload).toMatchObject({ task_id: r.task_id, task_type: 'appointment', mode: 'phone', origin: 'app' });
    // A phone appointment may only be exactly 15 minutes and has no location.
    await w.expectError(() => w.call(w.base({ p_end_at: hours(26) })), /always 15 minutes/);
    await w.expectError(() => w.call(w.base({ p_location: '12 Oak' })), /no location/);
  });
});

it('creates an in-person appointment with a pending calendar create row', async () => {
  await withWorld(async (w) => {
    await w.expectError(() => w.call(w.base({ p_mode: 'in_person' })), /needs an end time/);
    await w.expectError(() => w.call(w.base({ p_mode: 'in_person', p_end_at: hours(24.1) })), /between 15 minutes and 24 hours/);
    await w.expectError(() => w.call(w.base({ p_mode: 'in_person', p_end_at: hours(60) })), /between 15 minutes and 24 hours/);
    await w.expectError(() => w.call(w.base({ p_mode: 'in_person', p_end_at: hours(25), p_location: 'x'.repeat(501) })), /location is too long/);
    await w.expectError(() => w.call(w.base({ p_mode: 'in_person', p_end_at: hours(25), p_source_key: 'k' })), /cannot use a source key/);
    const due = hours(24);
    const r = await w.call(w.base({ p_due_at: due, p_mode: 'in_person', p_end_at: hours(25), p_location: '12 Oak St' }), 'authenticated', w.jarrad);
    expect(r).toMatchObject({ mode: 'in_person' });
    expect(r.ledger_id).toBeTruthy();
    const t = await w.row(r.task_id);
    expect(t).toMatchObject({ mode: 'in_person', location: '12 Oak St' });
    const led = await w.ledger(r.task_id);
    expect(led).toHaveLength(1);
    expect(led[0]).toMatchObject({ id: r.ledger_id, operation: 'create', phase: 'pending', old_assignee_id: w.jarrad, expected_generation: 0, calendar_chain_id: r.calendar_chain_id });
    expect(led[0].client_event_id).toMatch(/^[0-9a-v]{20,}$/);
  });
});

it('creates a task: custom type, property required, no appointment attribution', async () => {
  await withWorld(async (w) => {
    await w.expectError(() => w.call(w.base({ p_kind: 'task', p_property: null })), /needs a property/);
    await w.expectError(() => w.call(w.base({ p_kind: 'task', p_mode: 'in_person' })), /no mode/);
    await w.expectError(() => w.call(w.base({ p_kind: 'task', p_location: 'x' })), /cannot carry/);
    await w.expectError(() => w.call(w.base({ p_kind: 'task', p_idempotency_key: randomUUID() })), /cannot carry/);
    const r = await w.call(w.base({ p_kind: 'task', p_title: 'Send comps' }), 'authenticated', w.jarrad);
    expect(r).toMatchObject({ kind: 'task', calendar_chain_id: null, ledger_id: null, mode: 'phone' });
    expect(await w.row(r.task_id)).toMatchObject({ type: 'custom', next_step_kind: 'task', end_at: null, calendar_chain_id: null });
    expect(await w.attribution(r.task_id)).toHaveLength(0); // trigger is appointment-only
    expect(await w.events(r.task_id)).toMatchObject([{ event_type: 'task_created', source_type: 'tasks.created', actor_type: 'user' }]);
  });
});

it('guards the caller, the actor and the shape', async () => {
  await withWorld(async (w) => {
    await w.expectError(() => w.call(w.base({ p_actor: w.sam }), 'authenticated', w.jarrad), /FORBIDDEN/);
    await w.expectError(() => w.call(w.base({ p_actor: w.outsider, p_assignee: w.outsider }), 'authenticated', w.outsider), /FORBIDDEN: actor has no active membership/);
    await w.expectError(() => w.call(w.base({ p_actor: w.outsider }), 'service_role'), /FORBIDDEN: actor has no active membership/);
    await w.expectError(() => w.call(w.base(), 'anon'), /permission denied/);
    await w.expectError(() => w.call(w.base({ p_assignee: w.outsider })), /no active membership|assignee/);
    await w.expectError(() => w.call(w.base({ p_kind: 'meeting' })), /kind must be/);
    await w.expectError(() => w.call(w.base({ p_title: '   ' })), /title is required/);
    await w.expectError(() => w.call(w.base({ p_due_at: 'infinity' })), /finite/);
    await w.expectError(() => w.call(w.base({ p_origin: 'bogus' })), /unknown origin/);
    expect(await w.call(w.base({ p_actor: w.sam, p_assignee: w.jarrad }), 'authenticated', w.sam)).toMatchObject({ kind: 'appointment' });
  });
});

it('enforces the booking window only for user-originated calls', async () => {
  await withWorld(async (w) => {
    const years = (n: number) => new Date(Date.now() + n * 365 * 86_400_000).toISOString();
    await w.expectError(() => w.call(w.base({ p_due_at: years(3), p_enforce_window: true })), /within 1 hour in the past and 2 years/);
    await w.expectError(() => w.call(w.base({ p_due_at: hours(-2), p_enforce_window: true })), /within 1 hour in the past/);
    expect(await w.call(w.base({ p_due_at: hours(-0.5), p_enforce_window: true }), 'authenticated', w.jarrad)).toMatchObject({ duplicate: false });
    // A system writer (Jitter callbacks) may legitimately create a past-due step.
    expect(await w.call(w.base({ p_due_at: hours(-48), p_origin: 'jitter' }))).toMatchObject({ duplicate: false });
  });
});

it('replays by idempotency key and refuses a key reused for a different request', async () => {
  await withWorld(async (w) => {
    const key = randomUUID();
    const due = hours(24), end = hours(25);
    const first = await w.call(w.base({ p_due_at: due, p_idempotency_key: key, p_mode: 'in_person', p_end_at: end, p_location: 'Oak' }), 'authenticated', w.jarrad);
    const again = await w.call(w.base({ p_due_at: due, p_idempotency_key: key, p_mode: 'in_person', p_end_at: end, p_location: 'Oak' }), 'authenticated', w.jarrad);
    expect(again).toMatchObject({ duplicate: true, task_id: first.task_id, calendar_chain_id: first.calendar_chain_id, ledger_id: first.ledger_id });
    expect((await w.db.query('select count(*)::int n from public.tasks where org_id=$1 and booking_idempotency_key=$2', [w.org, key])).rows[0].n).toBe(1);
    expect((await w.db.query('select count(*)::int n from public.task_calendar_mutations where source_task_id=$1', [first.task_id])).rows[0].n).toBe(1);
    await w.expectError(() => w.call(w.base({ p_due_at: hours(30), p_idempotency_key: key, p_mode: 'in_person', p_end_at: hours(31), p_location: 'Oak' })), /idempotency key reuse with different request/);
    await w.expectError(() => w.call(w.base({ p_due_at: due, p_title: 'Other', p_idempotency_key: key, p_mode: 'in_person', p_end_at: end, p_location: 'Oak' })), /reuse with different request/);
  });
});

it('replays the lead-next-action key', async () => {
  await withWorld(async (w) => {
    const key = randomUUID();
    const args = w.base({ p_lead_next_action_key: key, p_title: 'Follow up' });
    const first = await w.call(args, 'authenticated', w.jarrad);
    expect(await w.call(args, 'authenticated', w.jarrad)).toMatchObject({ duplicate: true, task_id: first.task_id });
    expect((await w.row(first.task_id)).lead_next_action_idempotency_key).toBe(key);
    await w.expectError(() => w.call({ ...args, p_title: 'Different' }), /reuse with different request/);
    await w.expectError(() => w.call(w.base({ p_kind: 'task', p_lead_next_action_key: randomUUID() })), /cannot carry/);
  });
});

it('upserts by source key: in place, reopening, converting, and refusing unsafe changes', async () => {
  await withWorld(async (w) => {
    const key = `norma:${randomUUID()}`;
    const norma = (extra: Record<string, unknown>) => w.base({ p_source_key: key, p_origin: 'norma', p_title: 'Review', ...extra });
    const t1 = await w.call(norma({ p_kind: 'task' }));
    expect(await w.row(t1.task_id)).toMatchObject({ type: 'custom', source_key: key });
    expect(await w.events(t1.task_id)).toMatchObject([{ event_type: 'task_created', actor_type: 'system', actor_id: null }]);
    // Custom -> appointment conversion.
    const due = hours(5);
    const t2 = await w.call(norma({ p_kind: 'appointment', p_due_at: due, p_title: 'Call back' }));
    expect(t2).toMatchObject({ task_id: t1.task_id, converted: true, duplicate: false, kind: 'appointment' });
    expect(t2.calendar_chain_id).toBeTruthy();
    const converted = await w.row(t1.task_id);
    expect(converted).toMatchObject({ type: 'appointment', mode: 'phone', title: 'Call back', calendar_generation: 1, calendar_chain_id: t2.calendar_chain_id, assignee_id: w.jarrad });
    expect(new Date(converted.end_at).getTime() - new Date(converted.due_at).getTime()).toBe(900_000);
    expect(await w.attribution(t1.task_id)).toMatchObject([{ accountable_user_id: w.jarrad, source: 'next_step_conversion' }]);
    expect((await w.db.query('select count(*)::int n from public.tasks where org_id=$1 and source_key=$2', [w.org, key])).rows[0].n).toBe(1);
    expect(await w.ledger(t1.task_id)).toHaveLength(0);
    // The guard flag is not left on for the rest of the transaction.
    expect((await w.db.query("select coalesce(current_setting('sandra.allow_appointment_time_move',true),'') v")).rows[0].v).toBe('');
    // A closed appointment is never reopened or rewritten by a source key.
    await w.db.query("select set_config('sandra.allow_appointment_time_move','on',true)");
    await w.db.query("update public.tasks set status='completed', outcome='held', completed_at=now(), completed_by=$2 where id=$1", [t1.task_id, w.jarrad]);
    await w.db.query("select set_config('sandra.allow_appointment_time_move','',true)");
    await w.expectError(() => w.call(norma({ p_kind: 'appointment', p_due_at: hours(6) })), /closed, rescheduled or superseded/);
    await w.db.query("select set_config('sandra.allow_appointment_time_move','on',true)");
    await w.db.query("update public.tasks set status='open', outcome=null, completed_at=null, completed_by=null where id=$1", [t1.task_id]);
    // A successor in the same chain (a reschedule) also blocks, without creating a second open row.
    await w.db.query('savepoint succ');
    await w.db.query("insert into public.tasks(org_id,type,status,title,due_at,end_at,assignee_id,created_by,calendar_chain_id,related_property_id) values ($1,'appointment','open','succ',now()+interval '3 days',now()+interval '3 days 15 minutes',$2,$2,$3,$4)", [w.org, w.jarrad, t2.calendar_chain_id, w.property]);
    await w.db.query("select set_config('sandra.allow_appointment_time_move','',true)");
    await w.expectError(() => w.call(norma({ p_kind: 'appointment', p_due_at: hours(6) })), /closed, rescheduled or superseded/);
    expect((await w.db.query('select count(*)::int n from public.tasks where org_id=$1 and calendar_chain_id=$2', [w.org, t2.calendar_chain_id])).rows[0].n).toBe(2);
    await w.db.query('rollback to savepoint succ');
    // A completed non-appointment review task IS reopened (the original Norma behaviour).
    const rk = `norma:${randomUUID()}`;
    const rev = await w.call(w.base({ p_source_key: rk, p_origin: 'norma', p_kind: 'task', p_title: 'Review' }));
    await w.db.query("update public.tasks set status='completed', completed_at=now(), completed_by=$2 where id=$1", [rev.task_id, w.jarrad]);
    await w.call(w.base({ p_source_key: rk, p_origin: 'norma', p_kind: 'task', p_title: 'Review again' }));
    expect(await w.row(rev.task_id)).toMatchObject({ status: 'open', completed_at: null, title: 'Review again' });
    // Unsafe changes.
    await w.expectError(() => w.call(norma({ p_kind: 'task' })), /cannot be downgraded/);
    const otherProp = await w.prop();
    await w.expectError(() => w.call(norma({ p_kind: 'appointment', p_property: otherProp })), /different property/);
    await w.db.query("update public.tasks set google_calendar_event_id='evt1' where id=$1", [t1.task_id]);
    await w.expectError(() => w.call(norma({ p_kind: 'appointment', p_due_at: hours(9) })), /calendar event cannot change its time/);
    expect(await w.call(norma({ p_kind: 'appointment', p_due_at: (await w.row(t1.task_id)).due_at.toISOString() }))).toMatchObject({ task_id: t1.task_id });
  });
});

it('propagates DNC and training protections', async () => {
  await withWorld(async (w) => {
    const dnc = await w.prop('new_lead', 'is_dnc_locked=true');
    await w.expectError(() => w.call(w.base({ p_property: dnc })), /DNC_LOCKED/);
    await w.expectError(() => w.call(w.base({ p_property: dnc, p_kind: 'task' })), /DNC_LOCKED/);
    const training = await w.prop('new_lead', 'is_training=true');
    await w.expectError(() => w.call(w.base({ p_property: training })), /TRAINING_PROTECTED/);
  });
});

it('applies booking effects only when asked', async () => {
  await withWorld(async (w) => {
    const plain = await w.prop('prospect');
    await w.call(w.base({ p_property: plain }));
    expect((await w.db.query('select status,outreach_dispo from public.properties where id=$1', [plain])).rows[0]).toMatchObject({ status: 'prospect', outreach_dispo: null });
    const eff = await w.prop('prospect');
    const r = await w.call(w.base({ p_property: eff, p_apply_booking_effects: true }), 'authenticated', w.jarrad);
    expect(r.already_qualified).toBe(false);
    expect((await w.db.query('select status,outreach_dispo,qualified_by,follow_up_at from public.properties where id=$1', [eff])).rows[0]).toMatchObject({ status: 'new_lead', outreach_dispo: 'booked_appointment', qualified_by: w.jarrad, follow_up_at: null });
    const again = await w.call(w.base({ p_property: eff, p_apply_booking_effects: true, p_title: 'Second' }), 'authenticated', w.jarrad);
    expect(again.already_qualified).toBe(true);
  });
});

it('writes jitter and offer-backfill steps as system events with their own attribution source', async () => {
  await withWorld(async (w) => {
    const j = await w.call(w.base({ p_origin: 'jitter', p_title: 'Jitter callback', p_due_at: hours(1) }));
    expect(await w.events(j.task_id)).toMatchObject([{ event_type: 'task_created', source_type: 'tasks.created', actor_type: 'system', actor_id: null }]);
    expect(await w.attribution(j.task_id)).toMatchObject([{ source: 'booking_insert' }]);
    const b = await w.call(w.base({ p_origin: 'offer_backfill', p_title: 'Offer follow-up', p_due_at: hours(72) }));
    expect(await w.attribution(b.task_id)).toMatchObject([{ source: 'offer_backfill', accountable_user_id: w.jarrad }]);
    expect(await w.events(b.task_id)).toMatchObject([{ event_type: 'task_created', actor_type: 'system' }]);
    const o = await w.call(w.base({ p_origin: 'offer', p_title: 'Offer follow-up' }), 'authenticated', w.jarrad);
    expect(await w.events(o.task_id)).toMatchObject([{ event_type: 'appointment_booked', actor_type: 'user' }]);
  });
});

it('is not executable by anon and is a definer function with a fixed search path', async () => {
  await withWorld(async (w) => {
    const meta = (await w.db.query("select prosecdef, proconfig from pg_proc where proname='fn_create_next_step' and pronamespace='public'::regnamespace")).rows;
    expect(meta).toHaveLength(1);
    expect(meta[0].prosecdef).toBe(true);
    expect(meta[0].proconfig).toContain('search_path=""');
  });
});

it('refuses browser callers the service-only knobs and allows the service role', async () => {
  await withWorld(async (w) => {
    const auth = (extra: Record<string, unknown>) => w.call({ ...w.base(), p_enforce_window: true, ...extra }, 'authenticated', w.jarrad);
    await w.expectError(() => auth({ p_source_key: 'k' }), /FORBIDDEN: source keys are service-only/);
    await w.expectError(() => auth({ p_origin: 'norma' }), /FORBIDDEN: origin is service-only/);
    await w.expectError(() => auth({ p_origin: 'offer_backfill' }), /FORBIDDEN: origin is service-only/);
    await w.expectError(() => auth({ p_enforce_window: false }), /FORBIDDEN: the booking window is mandatory/);
    expect(await auth({ p_origin: 'board' })).toMatchObject({ kind: 'appointment' });
    expect(await w.call(w.base({ p_source_key: 'svc', p_origin: 'norma', p_due_at: hours(-3) }))).toMatchObject({ duplicate: false });
  });
});

it('a booking made by the legacy path is returned as the original when retried on the new path', async () => {
  await withWorld(async (w) => {
    const key = randomUUID();
    const due = new Date(Date.now() + 86_400_000), end = new Date(+due + 3_600_000), chain = randomUUID();
    // What fn_book_appointment leaves behind before this migration: phone default mode, one ledger row.
    const t = (await w.db.query(
      `insert into public.tasks(org_id,type,status,title,due_at,end_at,assignee_id,created_by,calendar_chain_id,related_property_id,booking_idempotency_key)
       values ($1,'appointment','open','Walkthrough',$2,$3,$4,$4,$5,$6,$7) returning id`,
      [w.org, due.toISOString(), end.toISOString(), w.jarrad, chain, w.property, key])).rows[0].id;
    await w.db.query("insert into public.task_calendar_mutations(org_id,calendar_chain_id,operation,phase,source_task_id,old_assignee_id,expected_generation) values ($1,$2,'create','pending',$3,$4,0)", [w.org, chain, t, w.jarrad]);
    const r = await w.call(w.base({ p_title: 'Walkthrough', p_due_at: due.toISOString(), p_mode: 'in_person', p_end_at: end.toISOString(), p_idempotency_key: key }), 'authenticated', w.jarrad);
    expect(r).toMatchObject({ duplicate: true, task_id: t });
    expect(r.ledger_id).toBeTruthy();
  });
});

it('a replay with a different location is refused, an identical one is returned', async () => {
  await withWorld(async (w) => {
    const key = randomUUID(), due = hours(48), end = new Date(Date.parse(due) + 3_600_000).toISOString();
    const args = (loc: string | null) => w.base({ p_due_at: due, p_mode: 'in_person', p_end_at: end, p_location: loc, p_idempotency_key: key });
    const first = await w.call(args('12 Oak St'), 'authenticated', w.jarrad);
    expect(await w.call(args('12 Oak St'), 'authenticated', w.jarrad)).toMatchObject({ duplicate: true, task_id: first.task_id });
    await w.expectError(() => w.call(args('99 Elm St'), 'authenticated', w.jarrad), /idempotency key reuse with different request/);
    await w.expectError(() => w.call(args(null), 'authenticated', w.jarrad), /idempotency key reuse with different request/);
  });
});

it('a replay that flips mode is refused (the legacy phone-with-ledger tolerance is covered above)', async () => {
  await withWorld(async (w) => {
    const key = randomUUID(), due = hours(48), end = new Date(Date.parse(due) + 3_600_000).toISOString();
    const inPerson = { p_due_at: due, p_mode: 'in_person', p_end_at: end, p_location: '12 Oak St', p_idempotency_key: key };
    await w.call(w.base(inPerson), 'authenticated', w.jarrad);
    // Same key, same times, but as a phone appointment: a different request.
    await w.expectError(() => w.call(w.base({ p_due_at: due, p_end_at: new Date(Date.parse(due) + 900_000).toISOString(), p_idempotency_key: key }), 'authenticated', w.jarrad), /idempotency key reuse with different request/);
  });
});
