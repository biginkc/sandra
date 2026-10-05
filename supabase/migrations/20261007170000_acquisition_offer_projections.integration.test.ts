import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { expect, it, describe } from 'vitest';
import { loadTestEnv } from '@tests/integration/env';
import { requireLoopbackPostgresUrl } from '@/lib/testing/loopback-postgres-url';
import { applyMyLeadsChain, chainThrough } from '@tests/integration/my-leads-housekeeping-fixture';
import { esignTemplateFixture, esignRequestFixture } from '@tests/integration/fixtures/esign';

// Local-only (127.0.0.1:54329). Every test but the last runs in one rolled-back transaction.
const url = process.env.TEST_SUPABASE_DB_URL ?? loadTestEnv().TEST_SUPABASE_DB_URL;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
type Role = 'authenticated' | 'anon' | 'service_role';

async function seedWorld(db: Client) {
  const org = randomUUID(), jarrad = randomUUID(), sam = randomUUID(), pat = randomUUID();
  for (const id of [jarrad, sam, pat]) await db.query('insert into auth.users(id) values ($1)', [id]);
  await db.query("insert into public.organizations(id,name) values ($1::uuid,'Offer projections '||$2::text)", [org, org]);
  await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'owner')", [jarrad, org]);
  for (const id of [sam, pat]) await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'member')", [id, org]);
  await db.query('insert into public.acquisition_org_settings(org_id,my_leads_enabled,needs_sequence_owner_id) values ($1,true,$2)', [org, jarrad]);
  await db.query("select set_config('request.jwt.claim.sub',$1,true)", [jarrad]);
  for (const id of [jarrad, sam, pat]) {
    await db.query("select set_config('my_leads.designation_update',$1,true)", [`${jarrad}:${org}:${id}`]);
    await db.query('update public.memberships set acquisitions_enabled=true where user_id=$1 and org_id=$2', [id, org]);
  }
  await db.query("select set_config('my_leads.designation_update','',true)");
  await db.query("select set_config('request.jwt.claim.sub','',true)");
  return { org, jarrad, sam, pat };
}

async function world(db: Client) {
  const w = await seedWorld(db);
  const { org, jarrad, sam, pat } = w;
  const staging = randomUUID();
  const template = esignTemplateFixture({ orgId: org, userId: jarrad, id: staging });
  await db.query(
    `insert into public.esign_template_staging_sources (id,org_id,storage_path,source_filename,source_size_bytes,content_type,source_sha256,created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [template.staging_source_id, org, template.staging_path, template.source_filename, template.source_size_bytes, template.source_content_type, template.source_sha256, jarrad]);
  await db.query(
    `insert into public.esign_templates (id,org_id,name,document_type,seller_role,signer_roles,merge_field_names,sign_template_id,provider_account_id,staging_source_id,source_filename,source_size_bytes,source_content_type,source_sha256,staging_path,finalized_at,lifecycle_state,created_by,updated_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'acct',$9,$10,$11,$12,$13,$14,$15,$16,$17,$17)`,
    [template.id, org, template.name, template.document_type, template.seller_role, JSON.stringify(template.signer_roles), template.merge_field_names,
      template.sign_template_id, template.staging_source_id, template.source_filename, template.source_size_bytes, template.source_content_type,
      template.source_sha256, template.staging_path, template.finalized_at, template.lifecycle_state, jarrad]);

  const as = async <T,>(role: Role, sub: string | null, run: () => Promise<T>) => {
    await db.query(`set local role ${role}`);
    await db.query("select set_config('request.jwt.claim.role',$1,true)", [role]);
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [sub ?? '']);
    try { return await run(); } finally { await db.query('reset role').catch(() => {}); await db.query("select set_config('request.jwt.claim.sub','',true)").catch(() => {}); }
  };
  const failure = async (run: () => Promise<unknown>) => {
    await db.query('savepoint s');
    let f: unknown = null;
    try { await run(); } catch (error) { f = error; }
    await db.query('rollback to savepoint s');
    await db.query('reset role');
    return f as (Error & { code?: string }) | null;
  };
  const prop = async (assignee: string | null = sam) => {
    const id = randomUUID();
    await db.query("insert into public.properties(id,org_id,address,state,status,assigned_user_id) values ($1,$2,$3,'MO','new_lead',$4)", [id, org, `${id.slice(0, 4)} Main`, assignee]);
    return id;
  };
  const closing = new Date(Date.now() + 30 * DAY).toISOString().slice(0, 10);
  const create = async (property: string, over: { intent?: string; actor?: string; cents?: number; hash?: string } = {}) => {
    const intent = over.intent ?? randomUUID();
    const id = (await db.query(
      'select public.fn_create_offer_projection($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::date,$10,null,null) as id',
      [org, property, over.actor ?? sam, intent, over.hash ?? 'h1', 's1', JSON.stringify({ offer_price: '$250,000.00' }), over.cents ?? 25000000, closing, 'no_motivation'])).rows[0].id as string;
    return { id, intent };
  };
  const sentAt = new Date(Date.now() - HOUR).toISOString();
  const request = async (property: string, intent: string, over: { retryOf?: string; state?: 'sending' | 'send_unknown' | 'sent'; price?: string } = {}) => {
    const r = esignRequestFixture({ orgId: org, propertyId: property, templateId: template.id, userId: sam, sendIntentId: intent });
    r.merge_value_snapshot = { ...r.merge_value_snapshot, offer_price: over.price ?? '$250,000.00' } as typeof r.merge_value_snapshot;
    await db.query(
      `insert into public.esign_requests (id,org_id,property_id,template_id,signer_snapshot,merge_value_snapshot,send_intent_id,payload_hash,created_by,retry_of_request_id,created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, case when $10::uuid is null then now() - interval '2 hours' else now() end)`,
      [r.id, org, property, template.id, JSON.stringify(r.signer_snapshot), JSON.stringify(r.merge_value_snapshot), intent, r.payload_hash, sam, over.retryOf ?? null]);
    if (over.state === 'send_unknown') await db.query("update public.esign_requests set delivery_state='send_unknown' where id=$1", [r.id]);
    if (over.state === 'sent') await markSent(r.id);
    return r.id;
  };
  const markSent = (id: string) => db.query(
    "update public.esign_requests set delivery_state='sent', sign_request_id='sr_'||id::text, sent_at=$2 where id=$1", [id, sentAt]);
  const proj = async (id: string) => (await db.query('select * from public.acquisition_offer_projections where id=$1', [id])).rows[0];
  const project = async (id: string) => (await db.query('select public.fn_project_acquisition_offer($1) as r', [id])).rows[0].r as Json;
  const episode = async (property: string) => (await db.query('select id from public.acquisition_assignment_episodes where property_id=$1 and ended_at is null', [property])).rows[0].id as string;
  const logStaleOffer = async (property: string, by: string, hoursAgo = 3) => {
    const ep = await episode(property);
    return (await as('authenticated', by, async () => (await db.query(
      `select public.fn_log_acquisition_offer($1,$2,$3,0,'new_lead',$4,150000,'verbal',$5,$6,'no_motivation',null,null) as r`,
      [org, property, ep, randomUUID(), new Date(Date.now() - hoursAgo * HOUR).toISOString(), new Date(Date.now() + DAY).toISOString()])).rows[0].r)) as Json;
  };
  const offers = async (property: string) => (await db.query('select * from public.acquisition_offers where property_id=$1 order by sent_at', [property])).rows;
  const sentProjection = async (property: string, over: Parameters<typeof create>[1] = {}) => {
    const p = await create(property, over);
    const reqId = await request(property, p.intent);
    await markSent(reqId);
    return { ...p, reqId };
  };
  return { ...w, as, failure, prop, create, request, markSent, proj, project, offers, logStaleOffer, sentProjection, template, closing, sentAt, episode };
}

async function withTx(fn: (db: Client, w: Awaited<ReturnType<typeof world>>) => Promise<void>) {
  if (!url) throw new Error('Missing TEST_SUPABASE_DB_URL');
  const db = new Client({ connectionString: requireLoopbackPostgresUrl(url) });
  await db.connect();
  try {
    await db.query('begin');
    await applyMyLeadsChain(db, chainThrough('offerProjections'));
    await fn(db, await world(db));
  } finally {
    await db.query('rollback').catch(() => undefined);
    await db.end();
  }
}

describe('20261007170000_acquisition_offer_projections', () => {
  it('widens outcome to superseded but keeps the outcome-by rule, and a superseded offer cannot be declined', async () => {
    await withTx(async (db, w) => {
      const property = await w.prop();
      const logged = await w.logStaleOffer(property, w.sam);
      await db.query("update public.acquisition_offers set outcome='superseded', outcome_at=now(), outcome_by=$1 where id=$2", [w.sam, logged.offerId]);
      const f = await w.failure(() => db.query("update public.acquisition_offers set outcome_by=null where id=$1", [logged.offerId]));
      expect(f?.message).toMatch(/acquisition_offers_outcome_check/);
      const declined = await w.failure(() => w.as('authenticated', w.sam, () => db.query(
        "select public.fn_decline_acquisition_offer($1,$2,$3,0,'new_lead',$4,$5)", [w.org, property, logged.offerId, randomUUID(), new Date(Date.now() - 1000).toISOString()])));
      expect(declined).not.toBeNull();
    });
  });

  it('logs the offer only after the contract is sent, exactly once, with the stored follow-up date', async () => {
    await withTx(async (db, w) => {
      const property = await w.prop();
      const p = await w.create(property);
      const req = await w.request(property, p.intent);
      expect((await w.proj(p.id)).esign_request_id).toBe(req);
      expect((await w.proj(p.id)).state).toBe('awaiting_send');
      expect(await w.offers(property)).toHaveLength(0);
      expect((await w.project(p.id)).state).toBe('awaiting_send');
      expect(await w.offers(property)).toHaveLength(0);
      await w.markSent(req);
      expect((await w.proj(p.id)).state).toBe('pending');
      const r = await w.project(p.id);
      expect(r.state).toBe('logged');
      const rows = await w.offers(property);
      expect(rows).toHaveLength(1);
      expect(rows[0].sent_via).toBe('dropbox_sign');
      expect(new Date(rows[0].sent_at).toISOString()).toBe(w.sentAt);
      expect(Number(rows[0].amount_cents)).toBe(25000000);
      expect((await db.query('select status from public.properties where id=$1', [property])).rows[0].status).toBe('offer_sent');
      expect((await db.query('select stage from public.acquisition_queue_states where property_id=$1', [property])).rows[0].stage).toBe('offer_sent');
      expect((await w.project(p.id)).offerId).toBe(rows[0].id);
      expect(await w.offers(property)).toHaveLength(1);
      const after = await w.proj(p.id);
      expect(after.resolution).toBe('auto');
      // closing in 30 days minus 3 days at 09:00 Central
      expect(new Date(after.follow_up_at).getTime()).toBeGreaterThan(Date.now() + 20 * DAY);
      expect((await db.query("select current_setting('request.jwt.claim.sub', true) as s")).rows[0].s ?? '').toBe('');
    });
  });

  it('send_unknown keeps the projection waiting and logs once after the positive resolution', async () => {
    await withTx(async (db, w) => {
      const property = await w.prop();
      const p = await w.create(property);
      const req = await w.request(property, p.intent, { state: 'send_unknown' });
      expect((await w.proj(p.id)).state).toBe('awaiting_send');
      expect((await w.project(p.id)).state).toBe('awaiting_send');
      expect(await w.offers(property)).toHaveLength(0);
      await w.markSent(req);
      expect((await w.proj(p.id)).state).toBe('pending');
      expect((await w.project(p.id)).state).toBe('logged');
      expect(await w.offers(property)).toHaveLength(1);
    });
  });

  it('a failed send closes the projection, frees the slot, and a retry request copies it', async () => {
    await withTx(async (db, w) => {
      const property = await w.prop();
      const p = await w.create(property);
      const req = await w.request(property, p.intent);
      await db.query("update public.esign_requests set delivery_state='failed', error_message='SEND_FAILED' where id=$1", [req]);
      const failed = await w.proj(p.id);
      expect(failed.state).toBe('failed');
      expect(failed.resolution).toBe('send_failed');
      expect(await w.offers(property)).toHaveLength(0);
      const retryIntent = randomUUID();
      await w.request(property, retryIntent, { retryOf: req });
      const copy = (await db.query('select * from public.acquisition_offer_projections where send_intent_id=$1', [retryIntent])).rows[0];
      expect(copy.state).toBe('awaiting_send');
      expect(copy.amount_cents).toBe(failed.amount_cents);
      // never-claimed intents are abandoned and release the slot
      const other = await w.prop();
      const o = await w.create(other);
      expect((await db.query('select public.fn_abandon_offer_projection($1) as a', [o.id])).rows[0].a).toBe(true);
      expect((await w.proj(o.id)).resolution).toBe('never_claimed');
      await w.create(other);
    });
  });

  it('turns business conflicts into a conflict row instead of throwing, and still logs after a queue-version bump', async () => {
    await withTx(async (db, w) => {
      // PENDING_OFFER_EXISTS
      const a = await w.prop();
      const pa = await w.create(a);
      await w.logStaleOffer(a, w.sam);
      await w.markSent(await w.request(a, pa.intent));
      const ra = await w.project(pa.id);
      expect(ra).toMatchObject({ state: 'conflict', code: 'PENDING_OFFER_EXISTS' });
      // STALE_STATE (status closed under us)
      const b = await w.prop();
      const pb = await w.create(b);
      await w.markSent(await w.request(b, pb.intent));
      await db.query("update public.properties set status='closed' where id=$1", [b]);
      expect(await w.project(pb.id)).toMatchObject({ state: 'conflict', code: 'STALE_STATE' });
      // STALE_ASSIGNMENT (reassigned away from a non-owner actor)
      const c = await w.prop();
      const pc = await w.create(c);
      await w.markSent(await w.request(c, pc.intent));
      await db.query("update public.properties set assigned_user_id=$1 where id=$2", [w.pat, c]);
      expect(await w.project(pc.id)).toMatchObject({ state: 'conflict', code: 'STALE_ASSIGNMENT' });
      // DNC_LOCKED
      const d = await w.prop();
      const pd = await w.create(d);
      await w.markSent(await w.request(d, pd.intent));
      await db.query("update public.properties set is_dnc_locked=true where id=$1", [d]);
      expect(await w.project(pd.id)).toMatchObject({ state: 'conflict', code: 'DNC_LOCKED' });
      expect(await w.offers(d)).toHaveLength(0);
      // queue version bump between Send and sent still logs (CAS is re-read in the runner)
      const e = await w.prop();
      const pe = await w.create(e);
      await w.markSent(await w.request(e, pe.intent));
      await db.query("insert into public.acquisition_queue_states(org_id,property_id,stage,stage_entered_at,version) values ($1,$2,'needs_offer',now(),7) on conflict (org_id,property_id) do update set version=9", [w.org, e]);
      expect((await w.project(pe.id)).state).toBe('logged');
      // amount guard: the document price differs from the stored amount
      const f = await w.prop();
      const pf = await w.create(f);
      await w.markSent(await w.request(f, pf.intent, { price: '$1.00' }));
      expect(await w.project(pf.id)).toMatchObject({ state: 'conflict', code: 'AMOUNT_MISMATCH' });
    });
  });

  it('refuses a second open contract whatever the intent id (database guard)', async () => {
    await withTx(async (db, w) => {
      const property = await w.prop();
      await w.create(property);
      const f = await w.failure(() => w.create(property));
      expect(f?.message).toContain('OPEN_CONTRACT_EXISTS');
      // a logged contract that is still out for signature also blocks a new intent
      const other = await w.prop();
      const sent = await w.sentProjection(other);
      expect((await w.project(sent.id)).state).toBe('logged');
      expect((await w.failure(() => w.create(other)))?.message).toMatch(/OPEN_CONTRACT_EXISTS|PENDING_OFFER_EXISTS/);
      // same intent and same payload replays the same row
      const again = await w.create(await w.prop(), {});
      expect(again.id).toBeTruthy();
      const replay = (await db.query(
        'select public.fn_create_offer_projection($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::date,$10,null,null) as id',
        [w.org, property, w.sam, (await db.query('select send_intent_id from public.acquisition_offer_projections where property_id=$1', [property])).rows[0].send_intent_id, 'h1', 's1', '{}', 25000000, w.closing, 'no_motivation'])).rows[0].id;
      expect(replay).toBeTruthy();
    });
  });

  it('supersedes the stale offer and logs this one atomically, with replay and authorization rules', async () => {
    await withTx(async (db, w) => {
      const property = await w.prop();
      const p = await w.create(property);
      const reqId = await w.request(property, p.intent);
      const stale = await w.logStaleOffer(property, w.sam, 3);
      await w.markSent(reqId);
      expect(await w.project(p.id)).toMatchObject({ state: 'conflict', code: 'PENDING_OFFER_EXISTS' });
      const before = (await db.query('select delivery_state, sign_request_id, updated_at from public.esign_requests where id=$1', [reqId])).rows[0];
      const staleChain = (await db.query('select follow_up_calendar_chain_id c from public.acquisition_offers where id=$1', [stale.offerId])).rows[0].c;
      expect((await db.query("select count(*)::int n from public.tasks where calendar_chain_id=$1 and status<>'cancelled'", [staleChain])).rows[0].n).toBeGreaterThan(0);

      const supersede = (key: string, by: string) => w.as('authenticated', by, async () =>
        (await db.query('select public.fn_supersede_offer_and_log($1,$2,$3) as r', [w.org, p.id, key])).rows[0].r as Json);
      const outsider = await w.failure(() => supersede(randomUUID(), w.pat));
      expect(outsider?.message).toContain('FORBIDDEN');

      const key = randomUUID();
      const ok = await supersede(key, w.sam);
      expect(ok).toMatchObject({ ok: true, duplicate: false, supersededOfferId: stale.offerId });
      const rows = await w.offers(property);
      expect(rows.map((r) => r.outcome)).toEqual(['superseded', 'pending']);
      expect(rows[0].outcome_by).toBe(w.sam);
      const after = await w.proj(p.id);
      expect(after).toMatchObject({ state: 'logged', resolution: 'superseded_prior_offer', resolved_by: w.sam });
      expect((await db.query("select count(*)::int n from public.tasks where calendar_chain_id=$1 and status<>'cancelled'", [staleChain])).rows[0].n).toBe(0);
      expect((await db.query('select count(*)::int n from public.esign_requests where property_id=$1', [property])).rows[0].n).toBe(1);
      expect((await db.query('select delivery_state, sign_request_id, updated_at from public.esign_requests where id=$1', [reqId])).rows[0]).toEqual(before);
      const replay = await supersede(key, w.sam);
      expect(replay.duplicate).toBe(true);
      expect(await w.offers(property)).toHaveLength(2);
      // no longer in conflict
      expect((await w.failure(() => supersede(randomUUID(), w.sam)))?.message).toContain('STALE_STATE');
    });
  });

  it('never supersedes an offer made after the contract was sent', async () => {
    await withTx(async (db, w) => {
      const property = await w.prop();
      const p = await w.create(property);
      const reqId = await w.request(property, p.intent);
      await w.markSent(reqId); // sent one hour ago
      await w.logStaleOffer(property, w.sam, 0); // an offer logged now, after the send
      expect((await w.project(p.id)).code).toBe('PENDING_OFFER_EXISTS');
      const f = await w.failure(() => w.as('authenticated', w.sam, () => db.query('select public.fn_supersede_offer_and_log($1,$2,$3)', [w.org, p.id, randomUUID()])));
      expect(f?.message).toContain('STALE_STATE');
      expect((await w.offers(property))[0].outcome).toBe('pending');
    });
  });

  it('rolls the supersession back when the replacement cannot be logged', async () => {
    await withTx(async (db, w) => {
      const property = await w.prop();
      const p = await w.create(property);
      const reqId = await w.request(property, p.intent);
      const stale = await w.logStaleOffer(property, w.sam, 3);
      await w.markSent(reqId);
      await w.project(p.id);
      const staleChain = (await db.query('select follow_up_calendar_chain_id c from public.acquisition_offers where id=$1', [stale.offerId])).rows[0].c;
      // DNC lands after the conflict: the offer RPC refuses inside the atomic run
      await db.query('update public.properties set is_dnc_locked=true where id=$1', [property]);
      const f = await w.failure(() => w.as('authenticated', w.sam, () => db.query('select public.fn_supersede_offer_and_log($1,$2,$3)', [w.org, p.id, randomUUID()])));
      expect(f?.message).toContain('DNC_LOCKED');
      expect((await w.offers(property))[0].outcome).toBe('pending');
      expect((await db.query("select count(*)::int n from public.tasks where calendar_chain_id=$1 and status<>'cancelled'", [staleChain])).rows[0].n).toBeGreaterThan(0);
      expect((await db.query("select count(*)::int n from public.acquisition_commands where operation='supersede_acquisition_offer'")).rows[0].n).toBe(0);
      expect((await w.proj(p.id)).state).toBe('conflict');
    });
  });

  it('reassign then retry logs, and a retry by a non-owner non-assignee is forbidden', async () => {
    await withTx(async (db, w) => {
      const property = await w.prop();
      const p = await w.create(property);
      await w.markSent(await w.request(property, p.intent));
      await db.query('update public.properties set assigned_user_id=$1 where id=$2', [w.pat, property]);
      expect((await w.project(p.id)).code).toBe('STALE_ASSIGNMENT');
      await db.query('update public.properties set assigned_user_id=$1 where id=$2', [w.sam, property]);
      // an unrelated member who neither owns nor is assigned
      const stranger = randomUUID();
      await db.query('insert into auth.users(id) values ($1)', [stranger]);
      await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'member')", [stranger, w.org]);
      const f = await w.failure(() => w.as('authenticated', stranger, () => db.query('select public.fn_retry_offer_projection($1,$2)', [w.org, p.id])));
      expect(f?.message).toContain('FORBIDDEN');
      const res = await w.as('authenticated', w.sam, async () =>
        (await db.query("select public.fn_retry_offer_projection($1,$2,'reassigned') as r", [w.org, p.id])).rows[0].r as Json);
      expect(res.state).toBe('logged');
      expect((await w.proj(p.id)).resolution).toBe('reassigned');
    });
  });

  it('a voided contract cancels the projection and logged offers are untouched', async () => {
    await withTx(async (db, w) => {
      const a = await w.prop();
      const pa = await w.create(a);
      const reqA = await w.request(a, pa.intent);
      await w.markSent(reqA);
      await db.query("update public.esign_requests set void_requested_at=now() where id=$1", [reqA]);
      expect(await w.proj(pa.id)).toMatchObject({ state: 'cancelled', resolution: 'contract_cancelled' });
      const b = await w.prop();
      const pb = await w.sentProjection(b);
      await w.project(pb.id);
      await db.query("update public.esign_requests set void_requested_at=now() where id=$1", [pb.reqId]);
      expect((await w.proj(pb.id)).state).toBe('logged');
      expect(await w.offers(b)).toHaveLength(1);
    });
  });

  it('retries transient failures and gives up after twelve with PROJECTION_RETRY_EXHAUSTED', async () => {
    await withTx(async (db, w) => {
      const property = await w.prop();
      const p = await w.create(property);
      await w.markSent(await w.request(property, p.intent));
      // make the offer RPC raise an unlisted error: an unreadable motivation kind
      await db.query("update public.acquisition_offer_projections set motivation_kind='specified', motivation_text=null where id=$1", [p.id]).catch(() => undefined);
      await db.query(`create or replace function public.fn_log_acquisition_offer(p_org_id uuid, p_property_id uuid, p_expected_episode_id uuid, p_expected_queue_version bigint, p_expected_shared_status text, p_idempotency_key uuid, p_amount_cents bigint, p_sent_via text, p_sent_at timestamptz, p_follow_up_at timestamptz, p_motivation_kind text default null, p_motivation_text text default null, p_temperature text default null) returns jsonb language plpgsql as $$ begin raise exception 'TRANSIENT_TEST'; end $$`);
      for (let i = 1; i < 12; i++) {
        const r = await w.project(p.id);
        expect(r.state).toBe('pending');
        expect((await w.proj(p.id)).attempts).toBe(i);
      }
      const last = await w.project(p.id);
      expect(last.state).toBe('conflict');
      expect((await w.proj(p.id)).conflict_code).toBe('PROJECTION_RETRY_EXHAUSTED');
      expect((await db.query("select current_setting('request.jwt.claim.sub', true) as s")).rows[0].s ?? '').toBe('');
      expect((await db.query("select count(*)::int n from public.acquisition_commands where operation='log_acquisition_offer'")).rows[0].n).toBe(0);
    });
  });

  it('repair recovers a missed trigger and abandons old unlinked intents; due lists pending rows', async () => {
    await withTx(async (db, w) => {
      const a = await w.prop();
      const pa = await w.create(a);
      const reqA = await w.request(a, pa.intent);
      await db.query('alter table public.esign_requests disable trigger trg_offer_projection_state');
      await w.markSent(reqA);
      await db.query('alter table public.esign_requests enable trigger trg_offer_projection_state');
      expect((await w.proj(pa.id)).state).toBe('awaiting_send');
      const b = await w.prop();
      const pb = await w.create(b);
      await db.query("update public.acquisition_offer_projections set created_at = now() - interval '20 minutes' where id=$1", [pb.id]);
      expect((await db.query('select public.fn_offer_projection_repair() as n')).rows[0].n).toBe(2);
      expect((await w.proj(pa.id)).state).toBe('pending');
      expect(await w.proj(pb.id)).toMatchObject({ state: 'failed', resolution: 'never_claimed' });
      const due = (await db.query('select * from public.fn_offer_projection_due(10)')).rows.map((r) => r.fn_offer_projection_due);
      expect(due).toContain(pa.id);
    });
  });

  it('contract_follow_up_at: normal, too soon, tomorrow, today, and DST boundaries (Chicago)', async () => {
    await withTx(async (db) => {
      const f = async (closing: string, sent: string, days = 3, hour = 9) =>
        (await db.query("select to_char(public.contract_follow_up_at($1::date,$2::timestamptz,$3,$4::smallint) at time zone 'America/Chicago','YYYY-MM-DD HH24:MI') as t", [closing, sent, days, hour])).rows[0].t as string;
      expect(await f('2026-12-20', '2026-12-01T15:00:00Z')).toBe('2026-12-17 09:00');
      expect(await f('2026-12-02', '2026-12-01T15:00:00Z')).toBe('2026-12-02 09:00'); // too soon: next morning
      expect(await f('2026-12-03', '2026-12-01T15:00:00Z')).toBe('2026-12-02 09:00'); // closing tomorrow+1
      expect(await f('2026-12-01', '2026-12-01T15:00:00Z')).toBe('2026-12-02 09:00'); // closing today
      expect(await f('2026-11-04', '2026-10-01T15:00:00Z')).toBe('2026-11-01 09:00'); // fall-back day
      expect(await f('2027-03-17', '2027-02-01T15:00:00Z')).toBe('2027-03-14 09:00'); // spring-forward day
      expect(await f('2026-11-04', '2026-11-01T15:00:00Z')).toBe('2026-11-02 09:00'); // fallback after fall-back day
    });
  });

  it('RLS and grants: other orgs see nothing, authenticated cannot write, only service role projects', async () => {
    await withTx(async (db, w) => {
      const property = await w.prop();
      const p = await w.sentProjection(property);
      const seen = await w.as('authenticated', w.sam, async () => (await db.query('select count(*)::int n from public.acquisition_offer_projections')).rows[0].n);
      expect(seen).toBe(1);
      const outsider = randomUUID();
      const otherOrg = randomUUID();
      await db.query('insert into auth.users(id) values ($1)', [outsider]);
      await db.query("insert into public.organizations(id,name) values ($1,'Other')", [otherOrg]);
      await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'owner')", [outsider, otherOrg]);
      expect(await w.as('authenticated', outsider, async () => (await db.query('select count(*)::int n from public.acquisition_offer_projections')).rows[0].n)).toBe(0);
      for (const sql of [
        "update public.acquisition_offer_projections set state='failed'",
        "delete from public.acquisition_offer_projections",
      ]) {
        expect((await w.failure(() => w.as('authenticated', w.sam, () => db.query(sql))))?.message).toMatch(/permission denied/);
      }
      expect((await w.failure(() => w.as('authenticated', w.sam, () => db.query('select public.fn_project_acquisition_offer($1)', [p.id]))))?.message).toMatch(/permission denied/);
      expect((await w.failure(() => w.as('anon', null, () => db.query('select public.fn_list_offer_conflicts($1,$2)', [w.org, w.sam]))))?.message).toMatch(/permission denied/);
      const listed = await w.as('authenticated', w.sam, async () => (await db.query('select public.fn_list_offer_conflicts($1,$2) as r', [w.org, w.sam])).rows[0].r as Json);
      expect(listed).toEqual([]);
    });
  });
});

describe('open-contract guard under concurrency (committed rows on the disposable local database)', () => {
  it('two sends with different intent ids: exactly one proceeds, the other gets OPEN_CONTRACT_EXISTS', async () => {
    if (!url) throw new Error('Missing TEST_SUPABASE_DB_URL');
    const dbUrl = requireLoopbackPostgresUrl(url);
    const setup = new Client({ connectionString: dbUrl });
    await setup.connect();
    const a = new Client({ connectionString: dbUrl });
    const b = new Client({ connectionString: dbUrl });
    await a.connect();
    await b.connect();
    let org = '';
    const users: string[] = [];
    try {
      // The chain is applied for real on the disposable database so two connections can race.
      await setup.query('begin');
      await applyMyLeadsChain(setup, chainThrough('offerProjections'));
      await setup.query('commit');
      await setup.query('begin');
      const w = await seedWorld(setup);
      org = w.org;
      users.push(w.jarrad, w.sam, w.pat);
      const property = randomUUID();
      await setup.query("insert into public.properties(id,org_id,address,state,status,assigned_user_id) values ($1,$2,'9 Race','MO','new_lead',$3)", [property, org, w.sam]);
      await setup.query('commit');
      const call = (db: Client, intent: string) => db.query(
        'select public.fn_create_offer_projection($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::date,$10,null,null) as id',
        [org, property, w.sam, intent, `h-${intent}`, 's', '{}', 25000000, '2030-01-15', 'no_motivation']);
      await a.query('begin');
      await b.query('begin');
      await a.query("select set_config('lock_timeout','10s',true)");
      await b.query("select set_config('lock_timeout','10s',true)");
      const first = await call(a, randomUUID());
      const secondPending = call(b, randomUUID()).then(() => null, (error: Error) => error);
      await new Promise((resolve) => setTimeout(resolve, 300)); // b is now blocked on the property row lock
      await a.query('commit');
      const second = await secondPending;
      await b.query('rollback');
      expect(first.rows[0].id).toBeTruthy();
      expect(second?.message).toContain('OPEN_CONTRACT_EXISTS');
      const open = await setup.query("select count(*)::int n from public.acquisition_offer_projections where property_id=$1", [property]);
      expect(open.rows[0].n).toBe(1);
    } finally {
      await a.query('rollback').catch(() => undefined);
      await b.query('rollback').catch(() => undefined);
      if (org) {
        await setup.query('delete from public.acquisition_offer_projections where org_id=$1', [org]).catch(() => undefined);
        await setup.query('delete from public.organizations where id=$1', [org]).catch(() => undefined);
      }
      for (const id of users) await setup.query('delete from auth.users where id=$1', [id]).catch(() => undefined);
      await a.end();
      await b.end();
      await setup.end();
    }
  });
});
