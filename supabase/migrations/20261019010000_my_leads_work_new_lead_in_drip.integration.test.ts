import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { loadTestEnv } from '@tests/integration/env';
import { requireLoopbackPostgresUrl } from '@/lib/testing/loopback-postgres-url';

// 20261019010000 replaces my_leads_work_classified to carry one rule Jarrad approved word for word on 2026-10-19:
//
// "A lead that has never been called, but is in a working drip, goes to Waiting on them · In drip. If the drip stops or breaks,
//  it comes back to Needs attention."
//
// Part 1 re-runs the A1 and B1 decision-table suites, unchanged, with the migration chain extended through 20261019010000, so the
// shipped body is what they test. Part 2 covers the rule and its boundaries.
const A1_THEN = '20261015020200_my_leads_work_facts_zip_signed_touch.sql,20261015030000_my_leads_work_classified_perf.sql,20261015040000_my_leads_approved_snooze_multi_house.sql,20261019010000_my_leads_work_new_lead_in_drip.sql';
const B1_THEN = '20261015030000_my_leads_work_classified_perf.sql,20261015040000_my_leads_approved_snooze_multi_house.sql,20261019010000_my_leads_work_new_lead_in_drip.sql';

process.env.MY_LEADS_CLASSIFIER_EXTRA_MIGRATIONS = A1_THEN;
await import('./20261015010000_my_leads_work_queue_classifier.integration.test');
process.env.MY_LEADS_CLASSIFIER_EXTRA_MIGRATIONS = B1_THEN;
await import('./20261015020200_my_leads_work_facts_zip_signed_touch.integration.test');
delete process.env.MY_LEADS_CLASSIFIER_EXTRA_MIGRATIONS;

const strip = (t: string) => t.replace(/^[\s\S]*?\bbegin;\s*/im, '').replace(/\s*commit;\s*$/i, '');
const migration = strip(readFileSync(new URL('./20261019010000_my_leads_work_new_lead_in_drip.sql', import.meta.url), 'utf8'));
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
    await db.query(migration);
    await fn(db);
  } finally { await db.query('rollback').catch(() => {}); await db.end(); }
}

async function world(db: Client) {
  const org = randomUUID(), owner = randomUUID(), sam = randomUUID();
  for (const id of [owner, sam]) await db.query('insert into auth.users(id) values ($1)', [id]);
  await db.query("insert into public.organizations(id,name) values ($1,'New lead in drip')", [org]);
  await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'owner')", [owner, org]);
  await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'member')", [sam, org]);
  await db.query('insert into public.acquisition_org_settings(org_id,my_leads_enabled,needs_sequence_owner_id) values ($1,true,$2)', [org, owner]);
  await db.query("select set_config('request.jwt.claim.sub',$1,true)", [owner]);
  for (const id of [owner, sam]) {
    await db.query("select set_config('my_leads.designation_update',$1,true)", [`${owner}:${org}:${id}`]);
    await db.query('update public.memberships set acquisitions_enabled=true where user_id=$1 and org_id=$2', [id, org]);
  }
  await db.query("select set_config('my_leads.designation_update','',true)");
  await db.query("select set_config('request.jwt.claim.sub','',true)");

  const pAt = process.env.CLASSIFIER_TEST_ANCHOR ? new Date(process.env.CLASSIFIER_TEST_ANCHOR) : new Date();
  const at = (ms: number) => new Date(pAt.getTime() + ms).toISOString();
  const raw = async (sql: string, params: unknown[]) => {
    await db.query("set local session_replication_role='replica'");
    try { await db.query(sql, params); } catch (error) { await db.query('rollback'); throw error; }
    await db.query("set local session_replication_role='origin'");
  };
  let phoneSeq = 0;
  // A never-called lead, assigned exactly at pAt (no first-call warning drift).
  const fresh = async () => {
    const id = randomUUID(), contact = randomUUID();
    phoneSeq += 1;
    await db.query("insert into public.contacts(id,org_id,first_name,last_name,phone_1,phone_1_type) values ($1,$2,'Drip','Lead',$3,'mobile')",
      [contact, org, `+181678${String(phoneSeq).padStart(5, '0')}`]);
    await db.query("insert into public.properties(id,org_id,address,state,status,assigned_user_id,homeowner_contact_id) values ($1,$2,$3,'MO','new_lead',$4,$5)",
      [id, org, `${id.slice(0, 8)} Main`, sam, contact]);
    await raw('update public.acquisition_assignment_episodes set assigned_at=$2 where property_id=$1 and ended_at is null', [id, pAt.toISOString()]);
    return { id, contact };
  };
  const drip = async (property: string, o: { status?: string; pause?: string | null; next?: string | null; updated?: string } = {}) => {
    const seq = randomUUID(), enr = randomUUID(), step = randomUUID();
    await raw('insert into public.sequences(id,org_id,name) values ($1,$2,$3)', [seq, org, `Warm check-in ${seq}`]);
    await raw("insert into public.sequence_steps(id,sequence_id,step_index,action_type,template_body) values ($1,$2,0,'send_sms','hello')", [step, seq]);
    await raw(
      `insert into public.sequence_enrollments(id,org_id,sequence_id,property_id,status,current_step_index,next_run_at,pause_reason,updated_at,enrolled_at)
       values ($1,$2,$3,$4,$5,0,$6,$7,$8,$9)`,
      [enr, org, seq, property, o.status ?? 'active', o.next === undefined ? at(HOUR) : o.next, o.pause ?? null, o.updated ?? at(-MIN), at(-DAY)]);
    return enr;
  };
  const callback = (property: string, due: string) => raw(
    "insert into public.tasks(org_id,type,status,title,due_at,end_at,assignee_id,created_by,calendar_chain_id,related_property_id) values ($1,'appointment','open','Callback',$2,$3,$4,$4,$5,$6)",
    [org, due, new Date(new Date(due).getTime() + 15 * MIN).toISOString(), sam, randomUUID(), property]);
  const inbound = (property: string, contact: string, when: string) => raw(
    "insert into public.messages(id,org_id,channel,direction,body,status,property_id,contact_id,created_at,metadata) values ($1,$2,'sms','inbound','hi','received',$3,$4,$5,'{}')",
    [randomUUID(), org, property, contact, when]);
  const classified = async (): Promise<Record<string, Json>> => {
    const r = (await db.query('select * from public.my_leads_work_classified($1,$2,$3)', [org, sam, pAt.toISOString()])).rows;
    return Object.fromEntries(r.map((x) => [x.property_id, x]));
  };
  return { at, raw, fresh, drip, callback, inbound, classified };
}

const cell = (r: Json) => `${r.place}/${r.reason}/${r.row_no}`;

describe('Approved 2026-10-19: a never-called lead in a working drip waits in drip', () => {
  it('(a) never called, healthy active drip: Waiting on them · In drip (row 10)', async () => {
    await withDb(async (db) => {
      const w = await world(db);
      const l = await w.fresh(); await w.drip(l.id);
      const r = await w.classified();
      expect(r[l.id].stage).toBe('not_contacted');
      expect(r[l.id].attempts_count).toBe(0);
      expect(cell(r[l.id])).toBe('their_move/in_drip/10');
      expect(r[l.id].facts.drip.healthy).toBe(true);
    });
  });

  it('(a) a call-in-progress pause inside its 30-minute window is still a working drip', async () => {
    await withDb(async (db) => {
      const w = await world(db);
      const l = await w.fresh(); await w.drip(l.id, { status: 'paused', pause: 'call_in_progress', next: null, updated: w.at(-5 * MIN) });
      expect(cell((await w.classified())[l.id])).toBe('their_move/in_drip/10');
    });
  });

  type DripOpts = { status?: string; pause?: string | null; next?: string | null; updated?: string };
  const stopped: Array<[string, (at: (ms: number) => string) => DripOpts]> = [
    ['paused by the rep', () => ({ status: 'paused', pause: 'manual', next: null })],
    ['paused broken (provider_failed)', () => ({ status: 'paused', pause: 'provider_failed', next: null })],
    ['stuck (next run over an hour late)', (at) => ({ next: at(-2 * HOUR) })],
    ['call-in-progress pause older than 30 minutes', (at) => ({ status: 'paused', pause: 'call_in_progress', next: null, updated: at(-45 * MIN) })],
    ['completed', () => ({ status: 'completed', next: null })],
    ['opted out', () => ({ status: 'opted_out', next: null })],
  ];
  for (const [what, opts] of stopped) {
    it(`(b) the drip ${what}: back to Needs attention · New lead (row 3)`, async () => {
      await withDb(async (db) => {
        const w = await world(db);
        const l = await w.fresh(); await w.drip(l.id, opts(w.at));
        expect(cell((await w.classified())[l.id])).toBe('your_move/new_lead/3');
      });
    });
  }

  it('(b) the same lead flips back to row 3 when its healthy drip stops', async () => {
    await withDb(async (db) => {
      const w = await world(db);
      const l = await w.fresh(); const enr = await w.drip(l.id);
      expect(cell((await w.classified())[l.id])).toBe('their_move/in_drip/10');
      await w.raw("update public.sequence_enrollments set status='paused', pause_reason='manual', next_run_at=null where id=$1", [enr]);
      expect(cell((await w.classified())[l.id])).toBe('your_move/new_lead/3');
    });
  });

  it('(c) never called, healthy drip, but a due callback: still Needs attention · Due (row 4)', async () => {
    await withDb(async (db) => {
      const w = await world(db);
      const l = await w.fresh(); await w.drip(l.id); await w.callback(l.id, w.at(-10 * MIN));
      expect(cell((await w.classified())[l.id])).toBe('your_move/due/4');
    });
  });

  it('(c) never called, healthy drip, but an unhandled reply: still Needs attention · New reply (row 5)', async () => {
    await withDb(async (db) => {
      const w = await world(db);
      const l = await w.fresh(); await w.drip(l.id); await w.inbound(l.id, l.contact, w.at(-HOUR));
      expect(cell((await w.classified())[l.id])).toBe('your_move/new_reply/5');
    });
  });

  it('(d) never called, no drip: New lead (row 3), unchanged', async () => {
    await withDb(async (db) => {
      const w = await world(db);
      const l = await w.fresh();
      expect(cell((await w.classified())[l.id])).toBe('your_move/new_lead/3');
    });
  });
});

export {};
