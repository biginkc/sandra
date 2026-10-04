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
const schema = strip('./20261005120000_next_step_schema.sql');
const readModel = strip('./20261005121000_next_step_read_model.sql');
const lifecycle = strip('./20261005121200_next_step_mode_aware_lifecycle.sql');
const url = process.env.TEST_SUPABASE_DB_URL ?? loadTestEnv().TEST_SUPABASE_DB_URL;

it('keeps phone appointments off Google, leaves in-person unchanged, and cleans up existing events', async () => {
  if (!url) throw new Error('Missing TEST_SUPABASE_DB_URL');
  requireLoopbackPostgresUrl(url);
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query('begin');
    await db.query(schema);
    await db.query(readModel);
    await db.query(lifecycle);

    const org = randomUUID(), owner = randomUUID(), rep = randomUUID(), rep2 = randomUUID();
    for (const id of [owner, rep, rep2]) await db.query('insert into auth.users(id) values ($1)', [id]);
    await db.query("insert into public.organizations(id,name) values ($1,'Mode lifecycle')", [org]);
    await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'owner')", [owner, org]);
    for (const id of [rep, rep2]) await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'member')", [id, org]);
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [rep]);

    const appt = async (mode: 'phone' | 'in_person', eventId: string | null) => {
      const id = randomUUID(), chain = randomUUID();
      await db.query(
        `insert into public.tasks(id,org_id,type,status,title,due_at,end_at,assignee_id,created_by,calendar_chain_id,mode,location,google_calendar_event_id)
         values ($1,$2,'appointment','open','appt',now()+interval '2 days',now()+interval '2 days 30 minutes',$3,$3,$4,$5,$6,$7)`,
        [id, org, rep, chain, mode, mode === 'in_person' ? '1 Main St' : null, eventId]);
      return { id, chain };
    };
    const ledger = async (chain: string) =>
      (await db.query('select * from public.task_calendar_mutations where calendar_chain_id=$1 order by created_at, operation', [chain])).rows;
    const pending = (rows: Record<string, unknown>[]) => rows.filter((r) => ['pending', 'provider_done'].includes(r.phase as string));
    const call = async (sql: string, args: unknown[]) => (await db.query(sql, args)).rows[0].r;
    const reassign = (task: string, to: string, key: string | null = null) => call('select public.fn_reassign_appointment($1,$2,$3) as r', [task, to, key]);
    const reschedule = (task: string) => call(
      "select public.fn_reschedule_appointment($1, now()+interval '5 days', now()+interval '5 days 30 minutes', 'America/Chicago') as r", [task]);
    const cancel = (task: string) => call('select public.fn_cancel_appointment($1) as r', [task]);

    // ---- legacy booking is in-person ----
    const prop = randomUUID();
    await db.query("insert into public.properties(id,org_id,address,state,status) values ($1,$2,'Book Main','MO','new_lead')", [prop, org]);
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [rep]);
    const bookArgs = ["select public.fn_book_appointment($1,$2,now()+interval '3 days',now()+interval '3 days 30 minutes','America/Chicago','Walk',null,$3,null,$4) as r", [org, rep, prop, randomUUID()]];
    const booked = await call(bookArgs[0] as string, bookArgs[1] as unknown[]);
    expect((await db.query('select mode,type from public.tasks where id=$1', [booked.task_id])).rows[0]).toEqual({ mode: 'in_person', type: 'appointment' });
    const bookedRows = (await db.query('select operation,phase,id from public.task_calendar_mutations where source_task_id=$1', [booked.task_id])).rows;
    expect(bookedRows).toHaveLength(1);
    expect(bookedRows[0]).toMatchObject({ operation: 'create', phase: 'pending' });
    expect(booked.ledger_id).toBe(bookedRows[0].id);
    const replay = await call(bookArgs[0] as string, bookArgs[1] as unknown[]);
    expect(replay).toMatchObject({ task_id: booked.task_id, duplicate: true });

    // ---- reassign ----
    const p1 = await appt('phone', null);
    const r1 = await reassign(p1.id, rep2);
    let rows = await ledger(p1.chain);
    expect(pending(rows)).toHaveLength(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ operation: 'reassign', phase: 'finalized', event_id: null, new_assignee_id: rep2 });
    expect(r1.ledger_id).toBe(rows[0].id);
    expect((await db.query('select assignee_id from public.tasks where id=$1', [p1.id])).rows[0].assignee_id).toBe(rep2);
    // Not blocked afterwards: reassign back (unkeyed), still nothing pending.
    await reassign(p1.id, rep);
    expect(pending(await ledger(p1.chain))).toHaveLength(0);

    const p2 = await appt('phone', 'evt-phone-reassign');
    const r2 = await reassign(p2.id, rep2);
    rows = await ledger(p2.chain);
    expect(pending(rows)).toHaveLength(1);
    expect(pending(rows)[0]).toMatchObject({ operation: 'cancel', phase: 'pending', event_id: 'evt-phone-reassign', old_assignee_id: rep, new_assignee_id: rep2 });
    expect(rows.filter((r) => r.operation === 'reassign').every((r) => r.phase === 'finalized')).toBe(true);
    expect(r2.ledger_id).toBe(pending(rows)[0].id);
    expect(rows.some((r) => r.operation === 'create')).toBe(false);

    const i1 = await appt('in_person', 'evt-inperson-reassign');
    await reassign(i1.id, rep2);
    rows = await ledger(i1.chain);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ operation: 'reassign', phase: 'pending', event_id: 'evt-inperson-reassign', new_assignee_id: rep2 });
    expect(rows[0].client_event_id).toBeTruthy();
    const i2 = await appt('in_person', null);
    const ri2 = await reassign(i2.id, rep2);
    rows = await ledger(i2.chain);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ operation: 'reassign', phase: 'pending', event_id: null });
    expect(ri2.ledger_id).toBe(rows[0].id);

    // Keyed reassign replay on a phone row returns duplicate, with and without an event.
    for (const eventId of [null, 'evt-keyed']) {
      const k = await appt('phone', eventId);
      const key = randomUUID();
      const first = await reassign(k.id, rep2, key);
      expect(first.duplicate).toBe(false);
      const before = (await ledger(k.chain)).length;
      const again = await reassign(k.id, rep2, key);
      expect(again).toMatchObject({ duplicate: true, task_id: k.id, new_assignee_id: rep2 });
      expect(again.ledger_id).toBeTruthy();
      expect((await ledger(k.chain)).length).toBe(before);
    }

    // ---- reschedule ----
    const s1 = await appt('phone', null);
    const rs1 = await reschedule(s1.id);
    rows = await ledger(s1.chain);
    expect(pending(rows)).toHaveLength(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ operation: 'reschedule', phase: 'finalized', target_task_id: rs1.task_id });
    expect(rs1.ledger_id).toBe(rows[0].id);
    expect((await db.query('select google_calendar_event_id from public.tasks where id=$1', [rs1.task_id])).rows[0].google_calendar_event_id).toBeNull();

    // A relabeled legacy row that carries an event is cleaned up on its first reschedule.
    const s2 = await appt('phone', 'evt-legacy');
    const rs2 = await reschedule(s2.id);
    rows = await ledger(s2.chain);
    expect(pending(rows)).toHaveLength(1);
    expect(pending(rows)[0]).toMatchObject({ operation: 'cancel', phase: 'pending', event_id: 'evt-legacy', source_task_id: s2.id });
    expect(rows.filter((r) => r.operation === 'reschedule').every((r) => r.phase === 'finalized')).toBe(true);
    expect(rows.some((r) => r.operation === 'create')).toBe(false);
    expect(rs2.ledger_id).toBe(pending(rows)[0].id);
    expect((await db.query('select google_calendar_event_id from public.tasks where id=$1', [rs2.task_id])).rows[0].google_calendar_event_id).toBeNull();

    const s3 = await appt('in_person', 'evt-inperson-resched');
    const rs3 = await reschedule(s3.id);
    rows = await ledger(s3.chain);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ operation: 'reschedule', phase: 'pending', event_id: 'evt-inperson-resched', target_task_id: rs3.task_id });
    expect(rs3.ledger_id).toBe(rows[0].id);

    // ---- cancel ----
    const c1 = await appt('phone', null);
    const cr1 = await cancel(c1.id);
    rows = await ledger(c1.chain);
    expect(pending(rows)).toHaveLength(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ operation: 'cancel', phase: 'finalized', event_id: null });
    expect(cr1).toMatchObject({ status: 'cancelled', ledger_id: rows[0].id });

    const c2 = await appt('phone', 'evt-phone-cancel');
    const cr2 = await cancel(c2.id);
    rows = await ledger(c2.chain);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ operation: 'cancel', phase: 'pending', event_id: 'evt-phone-cancel' });
    expect(cr2.ledger_id).toBe(rows[0].id);

    const c3 = await appt('in_person', null);
    await cancel(c3.id);
    rows = await ledger(c3.chain);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ operation: 'cancel', phase: 'pending' });

    // No phone appointment anywhere produced a create/reschedule/reassign row the sweep could claim.
    const stray = await db.query(
      `select m.id from public.task_calendar_mutations m join public.tasks t on t.id=m.source_task_id
       where t.org_id=$1 and t.mode='phone' and m.phase in ('pending','provider_done') and m.operation <> 'cancel'`, [org]);
    expect(stray.rows).toHaveLength(0);
  } finally {
    await db.query('rollback').catch(() => {});
    await db.end();
  }
});
