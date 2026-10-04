import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { addLead, asUser, failure, service, withP2, world, type Json, type World } from '@tests/integration/dialpad-p2-fixture';

interface TaskOpts { property?: string; assignee?: string; dueInSeconds: number; mode?: 'phone' | 'in_person'; status?: string; type?: string; title?: string }
async function task(w: World, o: TaskOpts): Promise<string> {
  const id = randomUUID();
  await service(w.db, () => w.db.query(
    `insert into public.tasks (id, org_id, assignee_id, related_property_id, type, status, title, due_at, created_by, mode, location, calendar_chain_id, end_at)
     values ($1,$2,$3,$4,$5,$6,$7, now() + make_interval(secs => $8), $3, $9,
             case when $9 = 'in_person' then '1 Native Way' end, case when $5 = 'appointment' then gen_random_uuid() end,
             case when $5 = 'appointment' then now() + make_interval(secs => $8) + interval '30 minutes' end)`,
    [id, w.org, o.assignee ?? w.rep, o.property ?? w.property, o.type ?? 'callback', o.status ?? 'open', o.title ?? 'Call back', o.dueInSeconds, o.mode ?? 'phone']));
  return id;
}
const due = async (w: World, uid = w.rep, lookahead = '2 minutes', grace = '60 minutes'): Promise<Json[]> =>
  (await asUser(w.db, uid, () => w.db.query('select public.fn_my_leads_callbacks_due($1,$2::interval,$3::interval) as v', [w.org, lookahead, grace]))).rows[0].v;
const ids = (rows: Json[]) => rows.map((r) => r.taskId);

describe('20261006100900 callbacks due', () => {
  it('returns phone appointments due within 2 minutes or late by at most an hour, ordered by due', async () => {
    await withP2('callbacksDue', async (db) => {
      const w = await world(db);
      const soon = await task(w, { dueInSeconds: 90 });
      await task(w, { dueInSeconds: 180 }); // 3 minutes away: not yet
      const late59 = await task(w, { dueInSeconds: -59 * 60 });
      await task(w, { dueInSeconds: -61 * 60 }); // past the grace: strip-only overdue
      const now = await task(w, { dueInSeconds: 0 });
      const rows = await due(w);
      expect(ids(rows)).toEqual([late59, now, soon]);
      expect(rows[0]).toMatchObject({ taskId: late59, propertyId: w.property, title: 'Call back', minutesLate: 59 });
      expect(rows[2].minutesLate).toBe(0);
      expect(typeof rows[0].dueAt).toBe('string');
      // Wider lookahead/grace are honoured.
      expect(await due(w, w.rep, '5 minutes', '2 hours')).toHaveLength(5);
    });
  });

  it('excludes in-person, other assignees, completed, cancelled and snoozed rows', async () => {
    await withP2('callbacksDue', async (db) => {
      const w = await world(db);
      const keep = await task(w, { dueInSeconds: 30 });
      await task(w, { dueInSeconds: 30, mode: 'in_person', type: 'appointment' });
      await task(w, { dueInSeconds: 30, status: 'completed' });
      await task(w, { dueInSeconds: 30, status: 'cancelled' });
      await task(w, { dueInSeconds: 30, status: 'snoozed' });
      await task(w, { dueInSeconds: 30, type: 'custom' }); // next_step_kind = task, not appointment
      const other = await addLead(w, { phone: '(816) 555-0199', assignee: w.rep2 });
      await task(w, { dueInSeconds: 30, assignee: w.rep2, property: other.property });
      expect(ids(await due(w))).toEqual([keep]);
      expect(await due(w, w.rep2)).toHaveLength(1); // rep2 sees only their own
    });
  });

  it('excludes DNC-locked, dead/closed, deleted and reassigned leads', async () => {
    await withP2('callbacksDue', async (db) => {
      const w = await world(db);
      const keep = await task(w, { dueInSeconds: 30 });
      const dnc = await addLead(w, { phone: '(816) 555-0101' });
      await task(w, { dueInSeconds: 30, property: dnc.property });
      await service(db, () => db.query('update public.properties set is_dnc_locked=true where id=$1', [dnc.property]));
      const dead = await addLead(w, { phone: '(816) 555-0102' });
      await task(w, { dueInSeconds: 30, property: dead.property });
      await service(db, () => db.query("update public.properties set status='dead' where id=$1", [dead.property]));
      const gone = await addLead(w, { phone: '(816) 555-0103' });
      await task(w, { dueInSeconds: 30, property: gone.property });
      await service(db, () => db.query('update public.properties set deleted_at=now() where id=$1', [gone.property]));
      const moved = await addLead(w, { phone: '(816) 555-0104' });
      await task(w, { dueInSeconds: 30, property: moved.property });
      await db.query('update public.acquisition_assignment_episodes set ended_at=clock_timestamp() where property_id=$1 and ended_at is null', [moved.property]);
      expect(ids(await due(w))).toEqual([keep]);
    });
  });

  it('is personal: anon and service role are refused, another org sees nothing', async () => {
    await withP2('callbacksDue', async (db) => {
      const w = await world(db);
      await task(w, { dueInSeconds: 30 });
      const anon = await failure(db, async () => { await db.query('set local role anon'); await db.query('select public.fn_my_leads_callbacks_due($1)', [w.org]); });
      expect(anon.code).toBe('42501');
      const svc = await failure(db, () => service(db, () => db.query('select public.fn_my_leads_callbacks_due($1)', [w.org])));
      expect(svc.code).toBe('42501');
      const w2 = await world(db);
      expect(await due(w2)).toEqual([]);
      const cross = await failure(db, () => asUser(db, w2.rep, () => db.query('select public.fn_my_leads_callbacks_due($1)', [w.org])));
      expect(cross.code).toBe('42501');
    });
  });
});
