import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { loadTestEnv } from './env';
import { requireLoopbackPostgresUrl } from '@/lib/testing/loopback-postgres-url';
import { applyMyLeadsChain, chainThrough } from './my-leads-housekeeping-fixture';

// Shared harness for the P2 data-plane migrations (20261006100000..100900). Every suite runs inside one
// transaction that is rolled back; applyP2 uses the shared applyMyLeadsChain probe/rollback/apply helper.

export type P2Key = 'ledgerKeys' | 'intentTimeout' | 'phoneNumbers' | 'nativeMatching' | 'assignToLead' | 'artifactFetches'
  | 'ackPrompts' | 'apiDial' | 'redaction' | 'callbacksDue';

// Leaves the open transaction with the whole My Leads chain through `through` applied and nothing newer,
// whatever the database held before (rolls back the present migrations newest first, then applies).
export async function applyP2(db: Client, through: P2Key): Promise<void> {
  await applyMyLeadsChain(db, chainThrough(through));
}

export async function withP2(through: P2Key, fn: (db: Client) => Promise<void>): Promise<void> {
  const db = new Client({ connectionString: dbUrl() });
  await db.connect();
  try {
    await db.query('begin');
    await applyP2(db, through);
    await fn(db);
  } finally {
    await db.query('rollback').catch(() => {});
    await db.end();
  }
}

export const dbUrl = (): string => {
  const url = process.env.TEST_SUPABASE_DB_URL ?? loadTestEnv().TEST_SUPABASE_DB_URL;
  if (!url) throw new Error('Missing TEST_SUPABASE_DB_URL');
  requireLoopbackPostgresUrl(url);
  return url;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;
export type PgError = Error & { code?: string };

export async function as<T>(db: Client, role: 'service_role' | 'authenticated', sub: string | null, run: () => Promise<T>): Promise<T> {
  await db.query(`set local role ${role}`);
  await db.query("select set_config('request.jwt.claim.role',$1,true)", [role]);
  await db.query("select set_config('request.jwt.claim.sub',$1,true)", [sub ?? '']);
  try { return await run(); } finally { await db.query('reset role').catch(() => {}); }
}
export const service = <T,>(db: Client, run: () => Promise<T>) => as(db, 'service_role', null, run);
export const asUser = <T,>(db: Client, sub: string, run: () => Promise<T>) => as(db, 'authenticated', sub, run);

export async function failure(db: Client, run: () => Promise<unknown>): Promise<PgError> {
  await db.query('savepoint expect_failure');
  let error: PgError | undefined;
  try { await run(); } catch (e) { error = e as PgError; }
  await db.query('rollback to savepoint expect_failure');
  await db.query('reset role');
  if (!error) throw new Error('expected the statement to fail');
  return error;
}

export const REP_DIALPAD = '5150000000000001';
export const REP2_DIALPAD = '5150000000000002';
export const SELLER = '(816) 555-0142';
export const SELLER_E164 = '+18165550142';

export interface World {
  db: Client; org: string; owner: string; rep: string; rep2: string; contact: string; property: string; conn: string; now: number;
}

export interface WorldOptions { training?: boolean; flag?: boolean; connection?: boolean }

// One org, an owner, two acquisitions reps (each with a verified Dialpad binding), one seller contact
// (phone_1 = SELLER) on one property assigned to `rep`, and an active connection. With flag, native_matcher is on.
export async function world(db: Client, o: WorldOptions = {}): Promise<World> {
  const org = randomUUID(), owner = randomUUID(), rep = randomUUID(), rep2 = randomUUID();
  const contact = randomUUID(), property = randomUUID();
  for (const id of [owner, rep, rep2]) await db.query('insert into auth.users(id) values ($1)', [id]);
  await db.query('insert into public.organizations(id,name) values ($1,$2)', [org, `P2 ${org}`]);
  await service(db, async () => {
    await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'owner')", [owner, org]);
    for (const u of [rep, rep2]) await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'member')", [u, org]);
    for (const u of [rep, rep2]) {
      await db.query("select set_config('my_leads.designation_update', format(':%s:%s', $1::text, $2::text), true)", [org, u]);
      await db.query('update public.memberships set acquisitions_enabled=true where org_id=$1 and user_id=$2', [org, u]);
    }
    await db.query("select set_config('my_leads.designation_update', '', true)");
  });
  await db.query('insert into public.acquisition_org_settings(org_id,my_leads_enabled) values ($1,true)', [org]);
  await db.query("insert into public.contacts(id,org_id,first_name,last_name,phone_1,phone_1_type) values ($1,$2,'Sally','Seller',$3,'mobile')", [contact, org, SELLER]);
  await service(db, () => db.query(
    `insert into public.properties(id,org_id,address,city,state,homeowner_contact_id,assigned_user_id,is_training,status)
     values ($1,$2,'1 Native Way','Kansas City','MO',$3,$4,$5,'new_lead')`, [property, org, contact, rep, o.training ?? false]));
  const c = await service(db, () => db.query(
    "insert into public.dialpad_org_connections(org_id,status,cti_client_id,webhook_secret_ref) values ($1,'active','client_p2','env:DIALPAD_P2') returning id", [org]));
  await service(db, async () => {
    for (const [u, d] of [[rep, REP_DIALPAD], [rep2, REP2_DIALPAD]] as const) {
      const claim = await db.query('select public.fn_claim_dialpad_member_binding($1,$2,$3) as v', [org, u, d]);
      await db.query("select public.fn_verify_dialpad_member_binding($1,'owner_attestation','test-attestation')", [claim.rows[0].v.bindingId]);
    }
  });
  if (o.flag) await setFlag(db, org, 'native_matcher', true);
  return { db, org, owner, rep, rep2, contact, property, conn: c.rows[0].id, now: Date.now() };
}

export async function setFlag(db: Client, org: string, flag: string, on: boolean): Promise<void> {
  await db.query(
    `insert into public.my_leads_feature_flags(org_id, ${flag}) values ($1,$2)
     on conflict (org_id) do update set ${flag} = excluded.${flag}`, [org, on]);
}

// A second property for the same rep, with its own contact holding `phone`.
export async function addLead(w: World, o: { phone?: string; contact?: string; assignee?: string; address?: string; status?: string } = {}): Promise<{ property: string; contact: string }> {
  const property = randomUUID();
  let contact = o.contact;
  if (!contact) {
    contact = randomUUID();
    await w.db.query("insert into public.contacts(id,org_id,first_name,last_name,phone_1,phone_1_type) values ($1,$2,'Other','Seller',$3,'mobile')", [contact, w.org, o.phone ?? SELLER]);
  }
  await service(w.db, () => w.db.query(
    `insert into public.properties(id,org_id,address,city,state,homeowner_contact_id,assigned_user_id,status)
     values ($1,$2,$3,'Kansas City','MO',$4,$5,$6)`, [property, w.org, o.address ?? `${property.slice(0, 4)} Extra Rd`, contact, o.assignee ?? w.rep, o.status ?? 'new_lead']));
  return { property, contact };
}

export async function prepare(w: World, property = w.property, contact = w.contact, rep = w.rep): Promise<Json> {
  const r = await service(w.db, () => w.db.query(
    'select public.fn_prepare_dialpad_call_intent($1,$2,$3,$4,1::smallint,$5,null,600) as v', [w.org, rep, property, contact, randomUUID()]));
  return r.rows[0].v;
}

export interface Ev {
  callId?: string; state: string; at: number; custom?: string | null; master?: string; extra?: Record<string, unknown>;
  target?: boolean | string; direction?: 'inbound' | 'outbound'; number?: string;
}
export const CALL = '6543210987654321098';
export const LEG = '6543210987654321099';

export function payload(e: Ev): string {
  const body: Record<string, unknown> = {
    state: e.state, event_timestamp: e.at, external_number: e.number ?? SELLER_E164, internal_number: '+18165550100',
    direction: e.direction ?? 'outbound',
    ...(e.target === false ? {} : { target: { type: 'user', id: '__T__' } }),
    ...(e.custom ? { custom_data: e.custom } : {}), ...(e.extra ?? {}),
  };
  let text = JSON.stringify(body).replace('"__T__"', typeof e.target === 'string' ? e.target : REP_DIALPAD);
  text = text.replace(/^\{/, `{"call_id":${e.callId ?? CALL},${e.master ? `"master_call_id":${e.master},` : ''}`);
  return text;
}
export async function ingest(w: World, e: Ev): Promise<string> {
  const r = await service(w.db, () => w.db.query('select public.fn_ingest_dialpad_call_event($1,$2,1,$3) as v', [w.org, w.conn, payload(e)]));
  return r.rows[0].v.eventId;
}
export async function processEvent(w: World, eventId: string): Promise<Json> {
  const r = await service(w.db, () => w.db.query('select public.fn_process_dialpad_call_event($1) as v', [eventId]));
  return r.rows[0].v;
}
export async function deliver(w: World, e: Ev): Promise<Json> {
  return processEvent(w, await ingest(w, e));
}
// A native (no custom_data) answered call: calling, connected, hangup.
export function nativeCall(w: World, o: { callId?: string; direction?: 'inbound' | 'outbound'; number?: string; offset?: number; target?: string; answered?: boolean } = {}): Ev[] {
  const start = w.now + 1000 + (o.offset ?? 0);
  const common = { callId: o.callId, direction: o.direction, number: o.number, target: o.target };
  const answered = o.answered ?? true;
  return [
    { ...common, state: 'calling', at: start, extra: { date_started: start } },
    ...(answered ? [{ ...common, state: 'connected', at: start + 4000, extra: { date_started: start, date_connected: start + 4000 } }] : []),
    { ...common, state: 'hangup', at: start + 64_000, extra: answered
      ? { date_started: start, date_connected: start + 4000, date_ended: start + 64_000, talk_time: 60_000 }
      : { date_started: start, date_ended: start + 20_000, talk_time: 0 } },
  ];
}
export async function ledger(w: World) {
  const i = await w.db.query('select * from public.dialpad_call_intents where org_id=$1 order by prepared_at, id', [w.org]);
  const a = await w.db.query('select * from public.call_activities where org_id=$1 order by created_at,id', [w.org]);
  const t = await w.db.query('select * from public.acquisition_attempts where org_id=$1 order by created_at,id', [w.org]);
  const e = await w.db.query('select * from public.dialpad_call_events where org_id=$1 order by event_timestamp_ms,id', [w.org]);
  return { intent: i.rows as Json[], activity: a.rows as Json[], attempt: t.rows as Json[], event: e.rows as Json[] };
}
