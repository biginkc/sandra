import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describePlan } from './plan-contract.mjs';
import { assertBackendTls } from './connection.mjs';

const CLAIM_PIN = JSON.parse(readFileSync(new URL('./expected/claims-shape.json', import.meta.url), 'utf8'));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const ACTIVE = "mb.access_status='active' AND (mb.access_expires_at IS NULL OR mb.access_expires_at > now()) AND mb.deletion_prepared_at IS NULL";
const COLS = `m.id, m.body, m.from_address, m.to_address, m.created_at, m.scheduled_for, m.property_id, m.contact_id,
  CASE WHEN p.id IS NULL THEN NULL ELSE jsonb_build_object('id',p.id,'address',p.address,'city',p.city,'state',p.state) END AS property,
  CASE WHEN c.id IS NULL THEN NULL ELSE jsonb_build_object('id',c.id,'first_name',c.first_name,'last_name',c.last_name,'entity_name',c.entity_name,'phone_1',c.phone_1) END AS contact`;
const JOIN = 'FROM public.messages m LEFT JOIN public.properties p ON p.id=m.property_id LEFT JOIN public.contacts c ON c.id=m.contact_id';
const ORDER = 'ORDER BY m.scheduled_for ASC NULLS LAST, m.id ASC LIMIT 101';
export const SHAPES = Object.freeze({
  first: `SELECT ${COLS} ${JOIN} WHERE m.status='queued' ${ORDER}`,
  keyset: `SELECT ${COLS} ${JOIN} WHERE m.status='queued' AND (m.scheduled_for > $1 OR (m.scheduled_for = $1 AND m.id > $2) OR m.scheduled_for IS NULL) ${ORDER}`,
  null_tail: `SELECT ${COLS} ${JOIN} WHERE m.status='queued' AND m.scheduled_for IS NULL AND m.id > $1 ${ORDER}`,
});
export async function openReadTxn(client, begin = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY') {
  await client.query(begin);
  const isolation = (await client.query('SHOW transaction_isolation')).rows[0].transaction_isolation;
  const readonly = (await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only;
  if (isolation !== 'repeatable read' || readonly !== 'on') throw new Error('READ_PRECONDITION_FAILED');
}
export async function preconditions(client) {
  const { rows } = await client.query(`SELECT has_table_privilege(current_user,'public.messages','SELECT') AS messages, has_table_privilege(current_user,'public.memberships','SELECT') AS memberships, has_table_privilege(current_user,'public.organizations','SELECT') AS organizations, has_table_privilege(current_user,'public.properties','SELECT') AS properties, has_table_privilege(current_user,'public.contacts','SELECT') AS contacts, ${['pg_class','pg_namespace','pg_proc','pg_type','pg_attribute','pg_attrdef','pg_constraint','pg_index','pg_trigger','pg_policy','pg_extension'].map(n => `has_table_privilege(current_user,'pg_catalog.${n}','SELECT') AS ${n}`).join(', ')}, has_table_privilege(current_user,'supabase_migrations.schema_migrations','SELECT') AS migration_ledger, has_function_privilege(current_user,'auth.uid()','EXECUTE') AS uid, has_function_privilege(current_user,'auth.role()','EXECUTE') AS role, pg_has_role(current_user,'authenticated','MEMBER') AS can_switch`);
  if (!Object.values(rows[0]).every(Boolean)) throw new Error('READ_PRECONDITION_FAILED');
}
export async function observe(client, org) {
  await openReadTxn(client);
  try {
    await preconditions(client);
    const { rows } = await client.query(`SELECT ${COLS},m.status ${JOIN} WHERE m.status='queued' AND m.org_id=$1 ORDER BY m.id`, [org]);
    await client.query('COMMIT');
    return snapshot(rows);
  } catch (e) { await client.query('ROLLBACK'); throw e; }
}
export function snapshot(rows) {
  // created_at is already in content. The nonexistent modification timestamp was excluded
  // from the old hash, so removing it cannot hide a change to hashed content.
  const per_row = Object.fromEntries(rows.map(({ id, status, ...content }) => [id, { hash: hash(content), status, created_at: content.created_at }]));
  return { count: rows.length, aggregate_sha256: hash(rows.map(row => [row.id, per_row[row.id].hash])), per_row };
}
export function reconcile(pre, post, current = {}) {
  const diff = [];
  for (const [id, value] of Object.entries(pre.per_row)) {
    if (!post.per_row[id]) diff.push({ id, hash: value.hash, status: current[id]?.status ?? 'unknown', created_at: current[id]?.created_at ?? null, kind: 'departed' });
    else if (post.per_row[id].hash !== value.hash) diff.push({ id, hash: post.per_row[id].hash, status: 'queued', created_at: post.per_row[id].created_at, kind: 'content_changed' });
  }
  for (const [id, value] of Object.entries(post.per_row)) if (!pre.per_row[id]) diff.push({ id, hash: value.hash, status: 'queued', created_at: value.created_at, kind: 'added' });
  return { verdict: diff.length ? 'INCONCLUSIVE' : 'PASS', diff };
}
export function compareSets(reference, visible) {
  if (!reference.length) throw new Error('INCONCLUSIVE EMPTY_SCOPE');
  if (reference.length > 200000 || visible.length > 200000) throw new Error('INCONCLUSIVE PROBE_BUDGET');
  const expected = new Set(reference.map(r => `${r.id}/${r.org_id}`));
  const actual = new Set(visible.map(r => `${r.id}/${r.org_id}`));
  if ([...actual].some(x => !expected.has(x))) throw new Error('FAIL RLS_LEAK');
  if ([...expected].some(x => !actual.has(x))) throw new Error('FAIL RLS_OVERRESTRICTIVE');
  return { verdict: 'PASS', count: expected.size, sha256: hash([...expected].sort()) };
}
export function planSkeleton(plan) {
  const out = [];
  function walk(node) {
    out.push({ node: node['Node Type'], relation: node['Relation Name'], index: node['Index Name'] });
    for (const child of node.Plans ?? []) walk(child);
  }
  walk(plan);
  return out;
}
async function explainShapes(client, cursor, tail) {
  const bindings = { first: [], keyset: [cursor.scheduled_for, cursor.id], null_tail: [tail.id] };
  const result = {};
  for (const [name, sql] of Object.entries(SHAPES)) {
    const raw = (await client.query(`EXPLAIN (FORMAT JSON) ${sql}`, bindings[name])).rows[0]['QUERY PLAN'][0].Plan;
    result[name] = describePlan(raw);
  }
  return result;
}
export async function collect(client, org, options = {}) {
  await client.query('SET default_transaction_read_only=on');
  await openReadTxn(client, options.begin);
  try {
    await preconditions(client);
    const tls = options.hosted ? await assertBackendTls(client) : null;
    await client.query("SET LOCAL statement_timeout='60s'");
    const now = (await client.query('SELECT now() AS at')).rows[0].at;
    const member = (await client.query(`SELECT mb.user_id FROM public.memberships mb WHERE mb.org_id=$1 AND ${ACTIVE} ORDER BY mb.created_at,mb.user_id LIMIT 1`, [org])).rows[0]?.user_id;
    if (!member) throw new Error('INCONCLUSIVE EMPTY_SCOPE');
    const orgs = (await client.query(`SELECT mb.org_id FROM public.memberships mb WHERE mb.user_id=$1 AND ${ACTIVE} ORDER BY mb.org_id`, [member])).rows.map(r => r.org_id);
    const queued = await client.query(`SELECT ${COLS},m.status ${JOIN} WHERE m.status='queued' AND m.org_id=$1 ORDER BY m.id`, [org]);
    const reference = (await client.query(`SELECT msg.id,msg.org_id FROM public.messages msg WHERE msg.status='queued' AND msg.org_id IN (SELECT mb.org_id FROM public.memberships mb WHERE mb.user_id=$1 AND ${ACTIVE}) ORDER BY msg.id LIMIT 200001`, [member])).rows;
    const currentStatus = options.previousIds?.length ? Object.fromEntries((await client.query('SELECT msg.id,msg.status,msg.created_at FROM public.messages msg WHERE msg.id=ANY($1::uuid[])', [options.previousIds])).rows.map(r => [r.id, {status:r.status, created_at:r.created_at}])) : {};
    if (!queued.rows.length) throw new Error('INCONCLUSIVE EMPTY_ORG');
    if (reference.length > 200000) throw new Error('INCONCLUSIVE PROBE_BUDGET');
    const privilegedFirst = (await client.query(SHAPES.first)).rows;
    const privilegedCursor = privilegedFirst.find(r => r.scheduled_for) ?? {scheduled_for:new Date(0),id:'00000000-0000-0000-0000-000000000000'};
    const privilegedTail = privilegedFirst.find(r => r.scheduled_for === null) ?? {id:'00000000-0000-0000-0000-000000000000'};
    const privilegedPlan = await explainShapes(client, privilegedCursor, privilegedTail);
    await client.query('SET LOCAL ROLE authenticated');
    const claims = { sub: member, role: CLAIM_PIN.role, aud: CLAIM_PIN.aud, email: CLAIM_PIN.email, exp: Math.floor(Date.now() / 1000) + 3600 };
    if (JSON.stringify(Object.keys(claims).sort()) !== JSON.stringify([...CLAIM_PIN.keys].sort())) throw new Error('FAIL CLAIM_PLUMBING');
    await client.query(`SELECT set_config('request.jwt.claims',$1,true),set_config('request.jwt.claim.sub',$2,true),set_config('request.jwt.claim.role','authenticated',true)`, [JSON.stringify(claims), member]);
    const self = (await client.query('SELECT auth.uid() AS uid,auth.role() AS role')).rows[0];
    if (self.uid !== member || self.role !== 'authenticated') throw new Error('FAIL CLAIM_PLUMBING');
    const first = (await client.query(SHAPES.first)).rows;
    const cursor = first.find(r => r.scheduled_for) ?? { scheduled_for: new Date(0), id: '00000000-0000-0000-0000-000000000000' };
    const tail = first.find(r => r.scheduled_for === null) ?? { id: '00000000-0000-0000-0000-000000000000' };
    const shapes = { first: first.length, keyset: (await client.query(SHAPES.keyset, [cursor.scheduled_for, cursor.id])).rowCount, null_tail: (await client.query(SHAPES.null_tail, [tail.id])).rowCount };
    const visible = (await client.query("SELECT msg.id,msg.org_id FROM public.messages msg WHERE msg.status='queued' ORDER BY msg.id LIMIT 200001")).rows;
    const rls = compareSets(reference, visible);
    const memberPlan = await explainShapes(client, cursor, tail);
    await client.query('RESET ROLE');
    await client.query('COMMIT');
    return { member_sub: member, member_orgs: orgs, snapshot_at: now, queued: snapshot(queued.rows), current_status: currentStatus, shapes, rls, plans: { privileged: privilegedPlan, member: memberPlan }, ...(tls ? { tls } : {}) };
  } catch (e) { await client.query('ROLLBACK'); throw e; }
}
export async function stabilityProbe(client, org, waitMs = 300000) {
  const first = await observe(client, org);
  await new Promise(resolve => setTimeout(resolve, waitMs));
  const second = await observe(client, org);
  if (reconcile(first, second).verdict !== 'PASS') throw new Error('FAIL UNSTABLE');
  return 'identical';
}
