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
const tools = strip('./20261005100000_my_leads_housekeeping_tools.sql');
const functions = strip('./20261005100100_my_leads_housekeeping_reassign.sql');
const outcome = strip('./20261005110000_acquisition_attempt_outcome_voicemail_not_logged.sql');
const rollbackFile = strip('../rollbacks/20261005110000_acquisition_attempt_outcome_voicemail_not_logged.sql');
const url = process.env.TEST_SUPABASE_DB_URL ?? loadTestEnv().TEST_SUPABASE_DB_URL;

it('widens the outcome check and closes only stale sandra attempts, reversibly', async () => {
  if (!url) throw new Error('Missing TEST_SUPABASE_DB_URL');
  requireLoopbackPostgresUrl(url);
  expect(outcome).not.toMatch(/^\s*(insert|update|delete)\s/im);
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query('begin');
    await db.query(tools);
    await db.query(functions);
    await db.query(outcome);

    const org = randomUUID(), jarrad = randomUUID(), maria = randomUUID();
    for (const id of [jarrad, maria]) await db.query('insert into auth.users(id) values ($1)', [id]);
    await db.query("insert into public.organizations(id,name) values ($1,'Close attempts')", [org]);
    const property = randomUUID();
    await db.query("insert into public.properties(id,org_id,address,state,status) values ($1,$2,'Close Main','MO','new_lead')", [property, org]);
    const attempt = async (over: { source?: string; outcome?: string | null; daysAgo?: number; actor?: string; key?: string }) => {
      const id = randomUUID();
      const source = over.source ?? 'sandra';
      await db.query(
        "insert into public.acquisition_attempts(id,org_id,property_id,actor_user_id,attempt_kind,source,outcome,occurred_at,provider_attempt_key,idempotency_key) values ($1,$2,$3,$4,'call',$5,$6,now()-($7||' days')::interval,$8,$9)",
        [id, org, property, over.actor ?? jarrad, source, over.outcome ?? null, String(over.daysAgo ?? 10),
          over.key ?? (source === 'dialpad' ? `dialpad-cti:${randomUUID()}` : `hk-${randomUUID()}`), randomUUID()]);
      return id;
    };
    const stale1 = await attempt({ daysAgo: 30 });
    const stale2 = await attempt({ daysAgo: 8, actor: maria });
    const fresh = await attempt({ daysAgo: 2 });
    const logged = await attempt({ daysAgo: 30, outcome: 'reached' });
    const cti = await attempt({ daysAgo: 30, source: 'dialpad' });

    const as = async <T>(role: 'authenticated' | 'service_role', fn: () => Promise<T>) => {
      await db.query(`set local role ${role}`);
      await db.query("select set_config('request.jwt.claim.role',$1,true)", [role]);
      try { return await fn(); } finally { await db.query('reset role').catch(() => {}); }
    };
    const expectError = async (run: () => Promise<unknown>, pattern: RegExp) => {
      await db.query('savepoint s');
      let failure: unknown = null;
      try { await run(); } catch (error) { failure = error; }
      await db.query('rollback to savepoint s');
      await db.query('reset role');
      expect(String((failure as Error)?.message)).toMatch(pattern);
    };
    const close = (apply: boolean, older = '7 days', fingerprint: string | null = null) => as('service_role', async () =>
      (await db.query('select public.fn_my_leads_housekeeping_close_attempts($1,$2::interval,$3,$4) as r', [org, older, apply, fingerprint])).rows[0].r);
    const info = (run: string) => as('service_role', async () => (await db.query('select public.fn_my_leads_housekeeping_run_info($1,$2) as r', [run, org])).rows[0].r);
    const rollback = async (run: string) => as('service_role', async () =>
      (await db.query('select public.fn_my_leads_housekeeping_rollback($1,$2,$3) as r', [run, org, (await info(run)).fingerprint])).rows[0].r);
    const outcomes = async () => Object.fromEntries((await db.query('select id,outcome from public.acquisition_attempts where org_id=$1', [org])).rows.map(r => [r.id, r.outcome]));

    // Constraint: accepts the two new values, rejects anything else, still allows pending (null).
    for (const value of ['voicemail', 'not_logged', 'reached', 'no_answer', 'wrong_number']) {
      await db.query('savepoint c');
      await db.query('update public.acquisition_attempts set outcome=$1 where id=$2', [value, fresh]);
      await db.query('rollback to savepoint c');
    }
    await expectError(() => db.query("update public.acquisition_attempts set outcome='bogus' where id=$1", [fresh]), /acquisition_attempts_outcome_check/);
    expect((await db.query("select count(*)::int n from pg_constraint where conrelid='public.acquisition_attempts'::regclass and conname='acquisition_attempts_outcome_check'")).rows[0].n).toBe(1);

    const before = await outcomes();
    // Preview writes nothing and is stable.
    const preview = await close(false);
    expect(preview).toMatchObject({ count: 2, withCallActivity: 0, pendingDialpadCti: 1 });
    expect(preview.byActor).toEqual(expect.arrayContaining([{ actor: jarrad, count: 1 }, { actor: maria, count: 1 }]));
    expect(await close(false)).toEqual(preview);
    expect(await outcomes()).toEqual(before);
    expect((await db.query('select count(*)::int n from public.my_leads_housekeeping_runs')).rows[0].n).toBe(0);
    await expectError(() => close(false, '1 hour'), /INVALID_INPUT/);

    // B3: apply is fenced to the previewed cohort.
    expect(preview.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    await expectError(() => close(true), /FINGERPRINT_REQUIRED/);
    await expectError(() => close(true, '7 days', 'a'.repeat(64)), /FINGERPRINT_MISMATCH/);
    // Same count, substituted rows: one stale row is finalised, a fresh one is backdated into the window.
    await db.query('savepoint sub');
    await db.query("update public.acquisition_attempts set outcome='reached' where id=$1", [stale1]);
    await db.query("update public.acquisition_attempts set occurred_at=now()-interval '20 days' where id=$1", [fresh]);
    expect((await close(false)).count).toBe(2);
    await expectError(() => close(true, '7 days', preview.fingerprint), /FINGERPRINT_MISMATCH/);
    await db.query('rollback to savepoint sub');
    // An edit between preview and apply with the same ids and count (backdating a candidate).
    await db.query('savepoint sub');
    await db.query("update public.acquisition_attempts set occurred_at=occurred_at-interval '1 day' where id=$1", [stale1]);
    await expectError(() => close(true, '7 days', preview.fingerprint), /FINGERPRINT_MISMATCH/);
    await db.query('rollback to savepoint sub');
    expect(await outcomes()).toEqual(before);
    // Another org id sees none of these rows.
    const otherOrg = randomUUID();
    await db.query("insert into public.organizations(id,name) values ($1,'Other')", [otherOrg]);
    const otherPreview = await as('service_role', async () => (await db.query('select public.fn_my_leads_housekeeping_close_attempts($1) as r', [otherOrg])).rows[0].r);
    expect(otherPreview).toMatchObject({ count: 0, pendingDialpadCti: 0 });

    // Apply closes only stale sandra rows; fresh, logged and dialpad rows are untouched.
    const applied = await close(true, '7 days', preview.fingerprint);
    expect(applied).toMatchObject({ closed: 2 });
    const after = await outcomes();
    expect(after[stale1]).toBe('not_logged');
    expect(after[stale2]).toBe('not_logged');
    expect(after[fresh]).toBeNull();
    expect(after[logged]).toBe('reached');
    expect(after[cti]).toBeNull();
    expect((await db.query('select count(*)::int n from public.rep_sms_obligations where org_id=$1', [org])).rows[0].n).toBe(0);
    expect(await close(true, '7 days', (await close(false)).fingerprint)).toMatchObject({ noop: true });
    const images = await db.query("select before->>'op' as op, count(*)::int n from public.my_leads_housekeeping_before_images where run_id=$1 group by 1", [applied.runId]);
    expect(images.rows).toEqual([{ op: 'updated', n: 2 }]);

    // A row finalised since the run is reported, not overwritten.
    await db.query("update public.acquisition_attempts set outcome='reached' where id=$1", [stale2]);
    const partial = await rollback(applied.runId);
    expect(partial).toMatchObject({ status: 'applied', restored: 1 });
    expect(partial.notRestored).toEqual([{ attempt: stale2, reason: 'outcome_changed_since' }]);
    expect((await outcomes())[stale1]).toBeNull();
    expect((await outcomes())[stale2]).toBe('reached');
    // Finish: put it back to the housekeeping value, then the rerun completes the rollback.
    await db.query("update public.acquisition_attempts set outcome='not_logged' where id=$1", [stale2]);
    const done = await rollback(applied.runId);
    expect(done).toMatchObject({ status: 'rolled_back', restored: 1, notRestored: [] });
    expect(await outcomes()).toEqual(before);

    // Access control.
    await expectError(() => as('authenticated', () => db.query('select public.fn_my_leads_housekeeping_close_attempts($1)', [org])), /permission denied/);
    await expectError(() => as('service_role', () => db.query('select public.fn_my_leads_housekeeping_rollback($1,$2,$3)', [applied.runId, otherOrg, 'x'])), /RUN_NOT_FOUND/);

    // Schema rollback twin: blocked while a row uses a new value, narrows the check otherwise.
    await db.query("update public.acquisition_attempts set outcome='voicemail' where id=$1", [fresh]);
    await expectError(() => db.query(rollbackFile), /ROLLBACK_BLOCKED/);
    await db.query('update public.acquisition_attempts set outcome=null where id=$1', [fresh]);
    await db.query(rollbackFile);
    await expectError(() => db.query("update public.acquisition_attempts set outcome='not_logged' where id=$1", [fresh]), /acquisition_attempts_outcome_check/);
  } finally { await db.query('rollback').catch(() => {}); await db.end(); }
});
