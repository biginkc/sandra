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
const queueLookup = strip('./20261003120000_my_leads_queue_row_lookup.sql');
const readModel = strip('./20261005121000_next_step_read_model.sql');
const url = process.env.TEST_SUPABASE_DB_URL ?? loadTestEnv().TEST_SUPABASE_DB_URL;

it('reads one next-step definition in the queue and detail, and a reschedule keeps mode and location', async () => {
  if (!url) throw new Error('Missing TEST_SUPABASE_DB_URL');
  requireLoopbackPostgresUrl(url);
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query('begin');
    await db.query(schema);
    await db.query(queueLookup);
    await db.query(readModel);

    const org = randomUUID(), owner = randomUUID(), rep = randomUUID();
    for (const id of [owner, rep]) await db.query('insert into auth.users(id) values ($1)', [id]);
    await db.query("insert into public.organizations(id,name) values ($1,'Read model')", [org]);
    await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'owner')", [owner, org]);
    await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'member')", [rep, org]);
    await db.query('insert into public.acquisition_org_settings(org_id,my_leads_enabled) values ($1,true)', [org]);
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [owner]);
    await db.query("select set_config('my_leads.designation_update',$1,true)", [`${owner}:${org}:${rep}`]);
    await db.query('update public.memberships set acquisitions_enabled=true where user_id=$1 and org_id=$2', [rep, org]);
    await db.query("select set_config('my_leads.designation_update','',true)");

    const prop = async (key: string) => {
      const id = randomUUID();
      await db.query("insert into public.properties(id,org_id,address,state,status,assigned_user_id) values ($1,$2,$3,'MO','new_lead',$4)", [id, org, `${key} Main`, rep]);
      return id;
    };
    const task = async (property: string, type: string, dueIn: string, extra: { mode?: string; location?: string; status?: string } = {}) => {
      const id = randomUUID();
      const appt = type === 'appointment';
      await db.query(
        `insert into public.tasks(id,org_id,type,status,title,due_at,end_at,assignee_id,created_by,related_property_id,calendar_chain_id,mode,location)
         values ($1,$2,$3,$4,$5,now()+$6::interval,case when $7 then now()+$6::interval+interval '30 minutes' end,$8,$8,$9,case when $7 then gen_random_uuid() end,$10,$11)`,
        [id, org, type, extra.status ?? 'open', `${type} task`, dueIn, appt, rep, property, extra.mode ?? 'phone', extra.location ?? null]);
      return id;
    };
    const queue = async () => {
      const rows = (await db.query('select property_id,row_data from public.my_leads_queue_rows($1,$2,now())', [org, rep])).rows;
      return Object.fromEntries(rows.map((r) => [r.property_id, r.row_data]));
    };

    // Earliest of callback / appointment / custom wins; custom never feeds the next step.
    const mixed = await prop('mixed');
    const callback = await task(mixed, 'callback', '1 day');
    await task(mixed, 'appointment', '3 days', { mode: 'in_person', location: '1 Main St' });
    await task(mixed, 'custom', '2 hours');
    const inPerson = await prop('inperson');
    await task(inPerson, 'appointment', '2 days', { mode: 'in_person', location: '9 Oak Ave' });
    const pastDue = await prop('pastdue');
    await task(pastDue, 'callback', '-2 days');
    const followUp = await prop('followup');
    await task(followUp, 'follow_up', '4 days');
    const customOnly = await prop('customonly');
    await task(customOnly, 'custom', '1 day');

    const rows = await queue();
    const dueOf = async (id: string) => (await db.query('select due_at from public.tasks where id=$1', [id])).rows[0].due_at as Date;
    expect(rows[mixed]).toMatchObject({ nextStepType: 'appointment', nextStepMode: 'phone' });
    expect(new Date(rows[mixed].nextStepAt).getTime()).toBe((await dueOf(callback)).getTime());
    expect(rows[inPerson]).toMatchObject({ nextStepType: 'appointment', nextStepMode: 'in_person' });
    expect(rows[followUp]).toMatchObject({ nextStepType: 'appointment', nextStepMode: 'phone' });
    // A past-due legacy callback is not a next step, and neither is a custom task.
    for (const id of [pastDue, customOnly]) {
      expect(rows[id].nextStepAt).toBeNull();
      expect(rows[id].nextStepType).toBeNull();
      expect(rows[id].nextStepMode).toBeNull();
    }
    // The single-lead lookup delegates to the same projection.
    const single = (await db.query('select * from public.my_leads_queue_rows_for($1,$2,now(),$3)', [org, rep, mixed])).rows;
    expect(single).toHaveLength(1);
    expect(single[0].row_data).toMatchObject({ nextStepType: 'appointment', nextStepMode: 'phone' });

    // The queue page (ordering test's function) still works over the replaced projection.
    await db.query('set local role authenticated');
    await db.query("select set_config('request.jwt.claim.role','authenticated',true)");
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [rep]);
    const page = (await db.query('select public.fn_get_acquisition_queue_page($1,$2) as p', [org, rep])).rows[0].p;
    await db.query('reset role');
    const pageRows = Object.values(page.stages as Record<string, { rows: { propertyId: string }[] }>).flatMap((s) => s.rows);
    expect(pageRows.map((r) => r.propertyId)).toEqual(expect.arrayContaining([mixed, inPerson, pastDue, followUp, customOnly]));

    // Detail appointments group: callbacks, appointments (and relabeled follow-ups) with mode/location; no custom.
    const detail = (await db.query("select fact from public.my_leads_detail_rows($1,$2,'appointments')", [org, mixed])).rows.map((r) => r.fact);
    expect(detail.map((f) => f.type).sort()).toEqual(['appointment', 'callback']);
    expect(detail.find((f) => f.type === 'appointment')).toMatchObject({ mode: 'in_person', location: '1 Main St' });
    expect(detail.find((f) => f.type === 'callback')).toMatchObject({ mode: 'phone', location: null });
    const fuDetail = (await db.query("select fact from public.my_leads_detail_rows($1,$2,'appointments')", [org, followUp])).rows;
    expect(fuDetail).toHaveLength(1);
    expect(fuDetail[0].fact).toMatchObject({ type: 'follow_up', mode: 'phone' });

    // Reschedule keeps mode and location on the successor (in-person) and stays phone otherwise.
    const reschedule = async (taskId: string) => {
      await db.query("select set_config('request.jwt.claim.sub',$1,true)", [rep]);
      return (await db.query(
        "select public.fn_reschedule_appointment($1, now()+interval '5 days', now()+interval '5 days 30 minutes', 'America/Chicago') as r", [taskId])).rows[0].r;
    };
    const inPersonTask = (await db.query("select id from public.tasks where related_property_id=$1 and type='appointment'", [inPerson])).rows[0].id;
    const res = await reschedule(inPersonTask);
    const successor = (await db.query('select mode,location,status from public.tasks where id=$1', [res.task_id])).rows[0];
    expect(successor).toEqual({ mode: 'in_person', location: '9 Oak Ave', status: 'open' });
    const phoneAppt = await prop('phoneappt');
    const phoneTask = await task(phoneAppt, 'appointment', '2 days');
    const res2 = await reschedule(phoneTask);
    expect((await db.query('select mode,location from public.tasks where id=$1', [res2.task_id])).rows[0]).toEqual({ mode: 'phone', location: null });
  } finally {
    await db.query('rollback').catch(() => {});
    await db.end();
  }
});
