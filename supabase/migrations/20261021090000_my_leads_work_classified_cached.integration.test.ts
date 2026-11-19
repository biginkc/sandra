import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { loadTestEnv } from '@tests/integration/env';
import { requireLoopbackPostgresUrl } from '@/lib/testing/loopback-postgres-url';

// PARITY GATE for 20261021090000 (performance only: plan caching + facts classify only the asked-for ids).
//
// The BASELINE is the shipped rules before this migration: my_leads_work_classified from 20261020130000 and the three
// wrappers from 20261015010000, installed side by side under *_baseline names. Every call any suite below makes to
// my_leads_work_classified / fn_my_leads_work_page / fn_my_leads_work_facts / fn_my_leads_badge_v2 is also run against the
// baseline in the same transaction and snapshot, and the two results must be identical (same rows, same JSON, same error code).
//
// Part 1 replays every existing classifier fixture suite (A1 decision table, B1 facts/zip/signed, approved snooze multi-house,
// approved new-lead-in-drip) with this migration applied after theirs. Part 2 is a dedicated multi-lead, multi-org fixture: every
// tab x chip x stage page, facts for every single id, complete id sets, missing ids, the cross-lead ledger receipt, and the badge.
const dir = new URL('.', import.meta.url);
const read = (f: string) => readFileSync(new URL(`./${f}`, dir), 'utf8');
const strip = (t: string) => t.replace(/^[\s\S]*?\bbegin;\s*/im, '').replace(/\s*commit;\s*$/i, '');
const NEW = strip(read('20261021090000_my_leads_work_classified_cached.sql'));
const NEW_MARK = 'create or replace function public.my_leads_work_classified_ids(';

const baselineSql = (() => {
  const classifier = strip(read('20261020130000_my_leads_work_new_lead_in_drip.sql'))
    .replaceAll('public.my_leads_work_classified(', 'public.my_leads_work_classified_baseline(');
  const a1 = read('20261015010000_my_leads_work_queue_classifier.sql');
  const wrappers = a1.slice(a1.indexOf('create or replace function public.fn_my_leads_work_page('), a1.lastIndexOf('commit;'))
    .replaceAll('public.my_leads_work_classified(', 'public.my_leads_work_classified_baseline(')
    .replaceAll('public.fn_my_leads_work_page(', 'public.fn_my_leads_work_page_baseline(')
    .replaceAll('public.fn_my_leads_work_facts(', 'public.fn_my_leads_work_facts_baseline(')
    .replaceAll('public.fn_my_leads_badge_v2(', 'public.fn_my_leads_badge_v2_baseline(');
  if (!classifier.includes('my_leads_work_classified_baseline(') || !wrappers.includes('fn_my_leads_badge_v2_baseline(')) throw new Error('baseline build failed');
  return `${classifier}\n;\n${wrappers}`;
})();
// THE ONE ALLOWED DIFFERENCE: the approved same-moment tie rules (Jarrad, 2026-10-20, verbatim):
//   "When two touches on a lead happen at the same moment and are the same type, the last touch shown is: for texts, your text,
//    then Sandra reply, then drip text, then campaign text; for calls, reached, then voicemail, then no answer."
//   "For calls, this order applies no matter which system recorded the call."
//   "If a touch is not one of the types named above (an "other" text or call), it loses the tie to any named type."
// The baseline breaks those ties arbitrarily (or by source). A result that differs from the baseline is accepted only when
// (a) it equals the baseline once every lastTouch.kind is blanked, and (b) for every lead whose lastTouch.kind differs, the
// baseline's pick was one of several different-kind touches at that same moment in the same type, and the new kind is the winner
// computed by referenceWinner below: written here from the rule texts and the raw tables, sharing no code with the migration.
const REF_TIER: Record<string, number> = { text: 1, call: 2, note: 3 };
const REF_RANK: Record<string, string[]> = {
  text: ['your_text', 'sandra_reply', 'drip_text', 'campaign_text'],
  call: ['call_reached', 'voicemail', 'call_no_answer'],
  note: [],
};
type RefTouch = { tier: string; kind: string };
// The touches of one lead at exactly `at` (all sources), classified independently of the migration.
const referenceTouches = async (c: Client, propertyId: string, at: string): Promise<RefTouch[]> => {
  // read the raw tables as the connecting superuser (a page call may be running as authenticated under RLS), then restore
  const role = ((await original.call(c, 'select current_user as r')).rows[0] as { r: string }).r;
  await original.call(c, 'reset role');
  try { return await referenceTouchesRaw(c, propertyId, at); }
  finally { await original.call(c, `set local role ${role === 'postgres' ? 'none' : role}`); }
};
const referenceTouchesRaw = async (c: Client, propertyId: string, at: string): Promise<RefTouch[]> => {
  const out: RefTouch[] = [];
  const texts = (await original.call(c, `select m.metadata, m.campaign_id,
        exists (select 1 from public.sequence_step_runs r where r.message_id = m.id) as drip
      from public.properties p join public.messages m on m.org_id = p.org_id and m.channel = 'sms' and m.direction = 'outbound'
        and m.status in ('sent', 'delivered')
        and (m.property_id = p.id or (m.property_id is null and m.contact_id = p.homeowner_contact_id))
      where p.id = $1 and coalesce(m.sent_at, m.delivered_at, m.created_at) = $2::timestamptz`, [propertyId, at])).rows as Array<{ metadata: Record<string, unknown> | null; campaign_id: string | null; drip: boolean }>;
  for (const t of texts) {
    const md = t.metadata ?? {};
    const gen = md.generated_by;
    const kind = t.drip ? 'drip_text' : t.campaign_id ? 'campaign_text' : gen === 'norma_precall' ? 'other'
      : md.approved_by_user_id != null ? 'your_text' : gen === 'ai_responder_v1' || md.reply_source === 'approved_template' ? 'sandra_reply'
        : gen == null ? 'your_text' : 'other';
    out.push({ tier: 'text', kind });
  }
  const attempts = (await original.call(c, 'select outcome from public.acquisition_attempts where property_id = $1 and occurred_at = $2::timestamptz', [propertyId, at])).rows as Array<{ outcome: string }>;
  for (const a of attempts) out.push({ tier: 'call', kind: ({ reached: 'call_reached', voicemail: 'voicemail', no_answer: 'call_no_answer' } as Record<string, string>)[a.outcome] ?? 'other' });
  const calls = (await original.call(c, `select talk_duration_seconds from public.call_activities where property_id = $1 and started_at = $2::timestamptz
      and direction is distinct from 'inbound'`, [propertyId, at])).rows as Array<{ talk_duration_seconds: number | null }>;
  for (const k of calls) out.push({ tier: 'call', kind: (k.talk_duration_seconds ?? 0) > 0 ? 'call_reached' : 'call_no_answer' });
  const notes = (await original.call(c, 'select 1 from public.lead_notes where property_id = $1 and created_at = $2::timestamptz', [propertyId, at])).rows;
  for (const _n of notes) out.push({ tier: 'note', kind: 'note' });
  return out;
};
const refRank = (t: RefTouch) => { const i = REF_RANK[t.tier].indexOf(t.kind); return i < 0 ? 99 : i; };
const referenceWinner = (ts: RefTouch[]) => [...ts].sort((x, y) => REF_TIER[x.tier] - REF_TIER[y.tier] || refRank(x) - refRank(y))[0];
const lastTouches = (rows: unknown[]) => {
  const m = new Map<string, { kind: string; at: string }>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    if (typeof o.propertyId === 'string' && o.lastTouch && typeof o.lastTouch === 'object') m.set(o.propertyId, o.lastTouch as { kind: string; at: string });
    Object.values(o).forEach(walk);
  };
  walk(rows);
  return m;
};
const tieExplained = async (c: Client, newRows: unknown[], baseRows: unknown[]) => {
  const n = lastTouches(newRows), b = lastTouches(baseRows);
  let diffs = 0;
  for (const [pid, nt] of n) {
    const bt = b.get(pid);
    if (!bt || bt.kind === nt.kind) continue;
    diffs += 1;
    if (bt.at !== nt.at) return false;
    const touches = await referenceTouches(c, pid, nt.at);
    const win = referenceWinner(touches);
    // the old pick must be a real same-moment, same-type, different-kind rival of the approved winner
    if (!win || win.kind !== nt.kind || !touches.some((t) => t.tier === win.tier && t.kind === bt.kind)) return false;
  }
  return diffs > 0;
};
const AFTER = `${NEW}\n;\n${baselineSql}`;
// Lines of every shipped classifier migration a suite may re-apply. A re-applied text with any other line is a suite's own
// MUTATION (a deliberately broken body proving a clause matters): that connection then keeps the mutated body, untouched and
// unshadowed, so the mutation test still proves what it proves.
const SHIPPED_LINES = new Set(['20261015010000_my_leads_work_queue_classifier.sql', '20261015020200_my_leads_work_facts_zip_signed_touch.sql',
  '20261015030000_my_leads_work_classified_perf.sql', '20261015040000_my_leads_approved_snooze_multi_house.sql',
  '20261020130000_my_leads_work_new_lead_in_drip.sql'].flatMap((f) => read(f).split('\n')));
const unshadowed = new WeakSet<Client>();
const CURRENT_MARK = '-- a snoozed offer follow-up is due at its snooze time';

// Shadow every classifier read against the baseline.
const CALL = /public\.(my_leads_work_classified|fn_my_leads_work_page|fn_my_leads_work_facts|fn_my_leads_badge_v2)\(/g;
const stats = { compared: 0, tieExempt: 0, errorsCompared: 0, mutationsSkipped: 0, earlierStates: 0, byFn: {} as Record<string, number> };
type Q = (this: Client, ...args: unknown[]) => Promise<{ rows: unknown[] }>;
const proto = Client.prototype as unknown as { query: Q };
const original = proto.query;
const canon = (rows: unknown[], blankLtKind = false) => rows.map((r) => JSON.stringify(r, (k, v) => (k === 'snapshotAt' ? undefined
  : blankLtKind && k === 'lastTouch' && v && typeof v === 'object' ? { ...v, kind: null } : v))).sort();
proto.query = async function patched(this: Client, ...args: unknown[]) {
  const [text, params] = args;
  if (typeof text !== 'string' || (params !== undefined && !Array.isArray(params))) return original.apply(this, args);
  if (text.includes('create or replace function public.my_leads_work_classified(') && !text.includes(NEW_MARK)) {
    // A suite (re)applied an older classifier body: put this migration (and the baseline) on top of it, unless it is a mutation.
    const res = await original.apply(this, args);
    // Only a text that reaches the current rules (20261015040000 or later) is upgraded; an earlier state (a suite's "before"
    // snapshot) is left as it is and unshadowed, since it is not the baseline.
    const current = text.includes(CURRENT_MARK);
    if (current && text.split('\n').every((l) => l === ';' || l === '' || SHIPPED_LINES.has(l))) { unshadowed.delete(this); await original.call(this, AFTER); }
    else { unshadowed.add(this); if (current) stats.mutationsSkipped += 1; else stats.earlierStates += 1; }
    return res;
  }
  const fns = [...text.matchAll(CALL)].map((m) => m[1]);
  if (fns.length === 0 || unshadowed.has(this) || /create or replace|_baseline\(/i.test(text)) return original.apply(this, args);
  const shadow = text.replace(CALL, (_m, fn: string) => `public.${fn}_baseline(`);
  let base: { ok: true; rows: unknown[] } | { ok: false; code: string } | null = null;
  try {
    await original.call(this, 'savepoint parity_shadow');
  } catch { return original.apply(this, args); }   // transaction already aborted: nothing to compare
  try {
    base = { ok: true, rows: (await original.call(this, shadow, params)).rows };
  } catch (error) { base = { ok: false, code: String((error as { code?: string }).code ?? error) }; }
  await original.call(this, 'rollback to savepoint parity_shadow');
  await original.call(this, 'release savepoint parity_shadow');
  let res: { rows: unknown[] };
  try {
    res = await original.apply(this, args);
  } catch (error) {
    const code = String((error as { code?: string }).code ?? error);
    if (base.ok) throw new Error(`PARITY: new ${fns.join(',')} failed (${code}) where baseline succeeded: ${text.slice(0, 200)}`);
    if (base.code !== code) throw new Error(`PARITY: error ${code} vs baseline ${base.code}`);
    stats.errorsCompared += 1;
    throw error;
  }
  if (!base.ok) throw new Error(`PARITY: baseline failed (${base.code}) where new succeeded: ${text.slice(0, 200)}`);
  const a = canon(res.rows), b = canon(base.rows);
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    if (JSON.stringify(canon(res.rows, true)) === JSON.stringify(canon(base.rows, true)) && await tieExplained(this, res.rows, base.rows)) {
      stats.tieExempt += 1; stats.compared += 1;
      for (const f of fns) stats.byFn[f] = (stats.byFn[f] ?? 0) + 1;
      return res;
    }
    const i = a.findIndex((x, j) => x !== b[j]);
    throw new Error(`PARITY MISMATCH in ${fns.join(',')} (${a.length} vs ${b.length} rows), first diff:\nNEW  ${a[i]}\nBASE ${b[i]}\nSQL ${text.slice(0, 300)}`);
  }
  stats.compared += 1;
  for (const f of fns) stats.byFn[f] = (stats.byFn[f] ?? 0) + 1;
  return res;
} as Q;

// Part 1: the existing suites, chain extended through the current rules (this file's patch then applies NEW on top).
const A1_THEN = '20261015020200_my_leads_work_facts_zip_signed_touch.sql,20261015030000_my_leads_work_classified_perf.sql,20261015040000_my_leads_approved_snooze_multi_house.sql,20261020130000_my_leads_work_new_lead_in_drip.sql';
const B1_THEN = '20261015030000_my_leads_work_classified_perf.sql,20261015040000_my_leads_approved_snooze_multi_house.sql,20261020130000_my_leads_work_new_lead_in_drip.sql';
process.env.MY_LEADS_CLASSIFIER_EXTRA_MIGRATIONS = A1_THEN;
await import('./20261015010000_my_leads_work_queue_classifier.integration.test');
process.env.MY_LEADS_CLASSIFIER_EXTRA_MIGRATIONS = B1_THEN;
await import('./20261015020200_my_leads_work_facts_zip_signed_touch.integration.test');
delete process.env.MY_LEADS_CLASSIFIER_EXTRA_MIGRATIONS;
await import('./20261015040000_my_leads_approved_snooze_multi_house.integration.test');
await import('./20261020130000_my_leads_work_new_lead_in_drip.integration.test');

// Part 2: dedicated fixture.
const url = process.env.TEST_SUPABASE_DB_URL ?? loadTestEnv().TEST_SUPABASE_DB_URL;
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const TABS = ['needs_attention', 'waiting', 'all'];
const CHIPS = [null, 'all', 'new_lead', 'call_today', 'due', 'new_reply', 'broken', 'offer', 'gone_quiet', 'nothing_planned', 'in_drip',
  'texted_last', 'offer_out', 'callback_booked', 'under_contract'];
const STAGES = [null, 'not_contacted', 'contacted', 'needs_offer', 'offer_sent', 'under_contract'];

describe('20261021090000 parity: dedicated multi-lead, multi-org fixture', () => {
  it('page / facts / badge / classifier are identical to the 20261020130000 baseline', async () => {
    if (!url) throw new Error('Missing TEST_SUPABASE_DB_URL');
    requireLoopbackPostgresUrl(url);
    const db = new Client({ connectionString: url });
    await db.connect();
    const before = stats.compared;
    try {
      await db.query('begin');
      await db.query(AFTER);
      const pAt = new Date(Date.UTC(2026, 9, 20, 17, 0, 0));
      const at = (ms: number) => new Date(pAt.getTime() + ms).toISOString();
      const raw = async (sql: string, p: unknown[]) => {
        await db.query("set local session_replication_role='replica'");
        await db.query(sql, p);
        await db.query("set local session_replication_role='origin'");
      };
      const owner = randomUUID(), sam = randomUUID();
      for (const id of [owner, sam]) await db.query('insert into auth.users(id) values ($1)', [id]);
      const orgs = [randomUUID(), randomUUID()];
      const leadsByOrg: Record<string, string[]> = {};
      for (const [n, org] of orgs.entries()) {
        await db.query('insert into public.organizations(id,name) values ($1,$2)', [org, `Parity ${n}`]);
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
        const leads: Array<{ id: string; contact: string }> = [];
        for (let i = 0; i < 14; i += 1) {
          const id = randomUUID(), contact = randomUUID();
          await db.query("insert into public.contacts(id,org_id,first_name,last_name,phone_1,phone_1_type) values ($1,$2,'P','Lead',$3,'mobile')",
            [contact, org, `+1816990${n}${String(i).padStart(3, '0')}`]);
          await db.query("insert into public.properties(id,org_id,address,state,status,assigned_user_id,homeowner_contact_id) values ($1,$2,$3,'MO','new_lead',$4,$5)",
            [id, org, `${i} Parity Main`, sam, contact]);
          await raw('update public.acquisition_assignment_episodes set assigned_at=$2 where property_id=$1 and ended_at is null', [id, at(-(i + 1) * HOUR)]);
          leads.push({ id, contact });
        }
        leadsByOrg[org] = leads.map((l) => l.id);
        const attempt = (p: string, when: string, outcome = 'no_answer') => raw(
          "insert into public.acquisition_attempts(org_id,property_id,actor_user_id,attempt_kind,source,occurred_at,recorded_at,idempotency_key,outcome) values ($1,$2,$3,'outreach','manual',$4,$4,$5,$6)",
          [org, p, sam, when, randomUUID(), outcome]);
        const msg = async (l: { id: string; contact: string }, dir: string, when: string, o: { status?: string; meta?: object; contactOnly?: boolean } = {}) => {
          const id = randomUUID();
          await raw(`insert into public.messages(id,org_id,channel,direction,body,status,property_id,contact_id,created_at,metadata,sent_at)
                     values ($1,$2,'sms',$3,'hi',$4,$5,$6,$7,$8,$9)`,
            [id, org, dir, o.status ?? (dir === 'inbound' ? 'received' : 'sent'), o.contactOnly ? null : l.id, l.contact, when, JSON.stringify(o.meta ?? {}),
              dir === 'outbound' && (o.status ?? 'sent') === 'sent' ? when : null]);
          return id;
        };
        const drip = async (p: string, o: { status?: string; pause?: string | null; next?: string | null } = {}) => {
          const seq = randomUUID(), enr = randomUUID(), step = randomUUID();
          await raw('insert into public.sequences(id,org_id,name) values ($1,$2,$3)', [seq, org, `Parity ${seq}`]);
          await raw("insert into public.sequence_steps(id,sequence_id,step_index,action_type,template_body) values ($1,$2,0,'send_sms','hello')", [step, seq]);
          await raw(`insert into public.sequence_enrollments(id,org_id,sequence_id,property_id,status,current_step_index,next_run_at,pause_reason,updated_at,enrolled_at)
                     values ($1,$2,$3,$4,$5,0,$6,$7,$8,$9)`,
            [enr, org, seq, p, o.status ?? 'active', o.next === undefined ? at(HOUR) : o.next, o.pause ?? null, at(-MIN), at(-DAY)]);
        };
        const task = (p: string, due: string) => raw(
          "insert into public.tasks(org_id,type,status,title,due_at,end_at,assignee_id,created_by,calendar_chain_id,related_property_id) values ($1,'appointment','open','Callback',$2,$3,$4,$4,$5,$6)",
          [org, due, new Date(new Date(due).getTime() + 15 * MIN).toISOString(), sam, randomUUID(), p]);
        const [l0, l1, l2, l3, l4, l5, l6, l7, l8, l9, l10, l11, l12, l13] = leads;
        // l0: never called, no drip -> new lead. l1: never called, healthy drip -> in drip (approved 2026-10-19 rule).
        await drip(l1.id);
        // l2: never called, broken drip -> new lead again.
        await drip(l2.id, { status: 'paused', pause: 'provider_failed', next: null });
        // l3: worked, callback due now. l4: worked, callback in the future. l5: worked, missed callback (9 days ago).
        for (const l of [l3, l4, l5, l6, l7, l8, l9, l10, l11, l12, l13]) await attempt(l.id, at(-20 * DAY));
        await task(l3.id, at(5 * MIN)); await task(l4.id, at(2 * DAY)); await task(l5.id, at(-9 * DAY));
        // l6: unhandled inbound reply. l7: inbound answered by a human text.
        await msg(l6, 'inbound', at(-2 * HOUR));
        await msg(l7, 'inbound', at(-3 * HOUR)); await msg(l7, 'outbound', at(-2 * HOUR));
        // l8: texted last 1 day ago (waiting). l9: texted 6 days ago (gone quiet). l10: failed human text (broken).
        await msg(l8, 'outbound', at(-DAY)); await msg(l9, 'outbound', at(-6 * DAY));
        await msg(l10, 'outbound', at(-HOUR), { status: 'failed' });
        // l11 / l12: the cross-lead ledger receipt. l11's outbound has a ledger row whose property is l12 (both in the queue), so
        // classifying l11 alone (facts) must still see the receipt exactly as the whole-queue run does.
        const m11 = await msg(l11, 'outbound', at(-2 * HOUR), { status: 'pending' });
        await raw(`insert into public.rep_sms_delivery_ledger(org_id,actor_user_id,submission_key,property_id,contact_id,sender_assignment_id,provider,
                     provider_account_id,provider_sender_id,from_number,to_number,body,state,claim_token,message_id,updated_at)
                   values ($1,$2,$3,$4,$5,$3,'sendillo','acct','snd','+18165550100','+18165550101','hi','accepted',$3,$6,$7)`,
          [org, sam, randomUUID(), l12.id, l12.contact, m11, at(-2 * HOUR)]);
        // l13: contact-only inbound (check texts label path).
        await msg(l13, 'inbound', at(-30 * MIN), { contactOnly: true });
        // a pin on l0 for the owner view
        void l0;
      }
      const iso = pAt.toISOString();
      const as = async (sub: string, run: () => Promise<unknown>) => {
        await db.query('set local role authenticated');
        await db.query("select set_config('request.jwt.claim.role','authenticated',true)");
        await db.query("select set_config('request.jwt.claim.sub',$1,true)", [sub]);
        try { return await run(); } finally { await db.query('reset role'); }
      };
      for (const org of orgs) {
        for (const member of [sam, owner]) {
          await db.query('select * from public.my_leads_work_classified($1,$2,$3)', [org, member, iso]);
          for (const tab of TABS) for (const chip of CHIPS) for (const stage of STAGES) {
            await as(member, () => db.query('select public.fn_my_leads_work_page($1,$2,$3,$4,$5,null,1,5,$6) as r', [org, member, tab, chip, stage, iso]));
          }
          for (const search of ['parity', '3 Parity', '816990', 'nope']) {
            await as(member, () => db.query('select public.fn_my_leads_work_page($1,$2,$3,null,null,$4,2,3,$5) as r', [org, member, 'all', search, iso]));
          }
        }
        const ids = leadsByOrg[org];
        for (const id of ids) await as(sam, () => db.query('select public.fn_my_leads_work_facts($1,$2,$3::uuid[],$4) as r', [org, sam, [id], iso]));
        await as(sam, () => db.query('select public.fn_my_leads_work_facts($1,$2,$3::uuid[],$4) as r', [org, sam, ids, iso]));
        await as(sam, () => db.query('select public.fn_my_leads_work_facts($1,$2,$3::uuid[],$4) as r', [org, sam, [], iso]));
        await as(sam, () => db.query('select public.fn_my_leads_work_facts($1,$2,$3::uuid[],$4) as r', [org, sam, [randomUUID(), ids[11], randomUUID(), ...leadsByOrg[orgs[1 - orgs.indexOf(org)]].slice(0, 3)], iso]));
        // whole-queue vs ids-only classification of every lead, directly
        const whole = (await db.query('select * from public.my_leads_work_classified($1,$2,$3) order by property_id', [org, sam, iso])).rows;
        const part = (await db.query('select * from public.my_leads_work_classified_ids($1,$2,$3,$4::uuid[]) order by property_id', [org, sam, iso, ids])).rows;
        expect(JSON.stringify(part)).toBe(JSON.stringify(whole));
        for (const id of ids) {
          const one = (await db.query('select * from public.my_leads_work_classified_ids($1,$2,$3,$4::uuid[])', [org, sam, iso, [id]])).rows;
          expect(JSON.stringify(one)).toBe(JSON.stringify(whole.filter((r) => r.property_id === id)));
        }
        // sanity: the fixture really reaches the paths it claims
        const reasons = new Set(whole.map((r) => `${r.reason}/${r.row_no}`));
        for (const want of ['new_lead/3', 'in_drip/10', 'due/4', 'callback_booked/11', 'due/9', 'new_reply/5', 'texted_last/13', 'gone_quiet/14']) {
          expect(reasons, want).toContain(want);
        }
      }
      for (const who of [sam, owner]) {
        const r = await as(who, () => db.query('select public.fn_my_leads_badge_v2($1) as n', [iso])) as { rows: Array<{ n: number }> };
        if (who === sam) expect(r.rows[0].n).toBeGreaterThan(0);
      }
      expect(stats.compared - before).toBeGreaterThan(2 * 2 * TABS.length * CHIPS.length * STAGES.length);
    } finally { await db.query('rollback').catch(() => {}); await db.end(); }
  }, 600_000);
});

// Approved tie rules (Jarrad, 2026-10-20): see THE ONE ALLOWED DIFFERENCE above for the three verbatim texts.
type TextKind = 'your_text' | 'sandra_reply' | 'drip_text' | 'campaign_text' | 'other_text';
// reached/voicemail/no_answer/other_call are acquisition attempts; ca_* are call_activities rows (another recording system).
type CallKind = 'reached' | 'voicemail' | 'no_answer' | 'other_call' | 'ca_reached' | 'ca_no_answer';
const TIE_CASES: Array<{ name: string; touches: Array<TextKind | CallKind>; want: string }> = [
  { name: 'your text vs Sandra reply', touches: ['sandra_reply', 'your_text'], want: 'your_text' },
  { name: 'your text vs drip', touches: ['drip_text', 'your_text'], want: 'your_text' },
  { name: 'your text vs campaign', touches: ['campaign_text', 'your_text'], want: 'your_text' },
  { name: 'Sandra reply vs drip', touches: ['drip_text', 'sandra_reply'], want: 'sandra_reply' },
  { name: 'Sandra reply vs campaign', touches: ['campaign_text', 'sandra_reply'], want: 'sandra_reply' },
  { name: 'drip vs campaign', touches: ['campaign_text', 'drip_text'], want: 'drip_text' },
  { name: 'all four texts', touches: ['campaign_text', 'drip_text', 'sandra_reply', 'your_text'], want: 'your_text' },
  { name: 'Sandra, drip, campaign', touches: ['campaign_text', 'drip_text', 'sandra_reply'], want: 'sandra_reply' },
  { name: 'reached vs voicemail', touches: ['voicemail', 'reached'], want: 'call_reached' },
  { name: 'reached vs no answer', touches: ['no_answer', 'reached'], want: 'call_reached' },
  { name: 'voicemail vs no answer', touches: ['no_answer', 'voicemail'], want: 'voicemail' },
  { name: 'all three calls', touches: ['no_answer', 'voicemail', 'reached'], want: 'call_reached' },
  { name: 'call log reached vs no answer', touches: ['ca_no_answer', 'ca_reached'], want: 'call_reached' },
  // "For calls, this order applies no matter which system recorded the call."
  { name: 'call log reached vs no-answer attempt', touches: ['no_answer', 'ca_reached'], want: 'call_reached' },
  { name: 'voicemail attempt vs call log reached', touches: ['voicemail', 'ca_reached'], want: 'call_reached' },
  { name: 'call log no answer vs voicemail attempt', touches: ['ca_no_answer', 'voicemail'], want: 'voicemail' },
  { name: 'same kind from both systems', touches: ['ca_reached', 'reached'], want: 'call_reached' },
  // "If a touch is not one of the types named above (an "other" text or call), it loses the tie to any named type."
  { name: 'other attempt vs no-answer attempt', touches: ['other_call', 'no_answer'], want: 'call_no_answer' },
  { name: 'other attempt vs call log no answer', touches: ['other_call', 'ca_no_answer'], want: 'call_no_answer' },
  { name: 'other text vs your text', touches: ['other_text', 'your_text'], want: 'your_text' },
  { name: 'other text vs campaign', touches: ['other_text', 'campaign_text'], want: 'campaign_text' },
];

describe('20261021090000 approved same-moment same-type last-touch tie rule', () => {
  it('picks the approved winner in the whole queue, page and every facts subset, stably', async () => {
    if (!url) throw new Error('Missing TEST_SUPABASE_DB_URL');
    requireLoopbackPostgresUrl(url);
    const db = new Client({ connectionString: url });
    await db.connect();
    const exemptBefore = stats.tieExempt;
    // Every fixture before this one (all non-tie suites) matched the baseline exactly: the exemption was never used.
    expect(exemptBefore).toBe(0);
    try {
      await db.query('begin');
      await db.query(AFTER);
      const iso = new Date(Date.UTC(2026, 9, 20, 17, 0, 0)).toISOString();
      const when = new Date(Date.UTC(2026, 9, 18, 15, 0, 0)).toISOString();
      const raw = async (sql: string, p: unknown[]) => {
        await db.query("set local session_replication_role='replica'");
        await db.query(sql, p);
        await db.query("set local session_replication_role='origin'");
      };
      const owner = randomUUID(), sam = randomUUID(), org = randomUUID();
      for (const id of [owner, sam]) await db.query('insert into auth.users(id) values ($1)', [id]);
      await db.query("insert into public.organizations(id,name) values ($1,'Tie org')", [org]);
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
      const add = async (p: string, contact: string, t: TextKind | CallKind) => {
        if (t.endsWith('_text') || t === 'sandra_reply') {
          const id = randomUUID();
          const meta = t === 'sandra_reply' ? { generated_by: 'ai_responder_v1' } : t === 'other_text' ? { generated_by: 'norma_precall' } : {};
          await raw(`insert into public.messages(id,org_id,channel,direction,body,status,property_id,contact_id,created_at,metadata,sent_at,campaign_id)
                     values ($1,$2,'sms','outbound','hi','sent',$3,$4,$5,$6,$5,$7)`,
            [id, org, p, contact, when, JSON.stringify(meta), t === 'campaign_text' ? randomUUID() : null]);
          if (t === 'drip_text') await raw("insert into public.sequence_step_runs(enrollment_id,step_id,message_id,scheduled_for) values ($1,$2,$3,$4)", [randomUUID(), randomUUID(), id, when]);
        } else if (t.startsWith('ca_')) {
          await raw(`insert into public.call_activities(id,org_id,property_id,contact_id,jitter_attempt_id,provider,started_at,ended_at,talk_duration_seconds)
                     values ($1,$2,$3,$4,$5,'dialpad',$6,$6,$7)`, [randomUUID(), org, p, contact, randomUUID(), when, t === 'ca_reached' ? 60 : 0]);
        } else {
          await raw("insert into public.acquisition_attempts(org_id,property_id,actor_user_id,attempt_kind,source,occurred_at,recorded_at,idempotency_key,outcome) values ($1,$2,$3,'outreach','manual',$4,$4,$5,$6)",
            [org, p, sam, when, randomUUID(), t === 'other_call' ? 'wrong_number' : t]);
        }
      };
      // Each case twice: losers inserted first, then winner first, so neither insertion order nor id order can pick the winner.
      const leads: Array<{ id: string; want: string; name: string }> = [];
      for (const c of TIE_CASES) for (const order of [c.touches, [...c.touches].reverse()]) {
        const id = randomUUID(), contact = randomUUID();
        await db.query("insert into public.contacts(id,org_id,first_name,last_name,phone_1,phone_1_type) values ($1,$2,'T','Lead',$3,'mobile')",
          [contact, org, `+1816880${String(leads.length).padStart(4, '0')}`]);
        await db.query("insert into public.properties(id,org_id,address,state,status,assigned_user_id,homeowner_contact_id) values ($1,$2,$3,'MO','new_lead',$4,$5)",
          [id, org, `${leads.length} Tie St`, sam, contact]);
        for (const t of order) await add(id, contact, t);
        leads.push({ id, want: c.want, name: `${c.name} (${order.join(',')})` });
      }
      const as = async <T,>(run: () => Promise<T>) => {
        await db.query('set local role authenticated');
        await db.query("select set_config('request.jwt.claim.role','authenticated',true)");
        await db.query("select set_config('request.jwt.claim.sub',$1,true)", [sam]);
        try { return await run(); } finally { await db.query('reset role'); }
      };
      type F = { propertyId: string; lastTouch: { kind: string; at: string } | null };
      const check = (rows: F[], ids: string[], label: string) => {
        for (const id of ids) {
          const l = leads.find((x) => x.id === id)!;
          const r = rows.find((x) => x.propertyId === id);
          expect(r?.lastTouch?.kind, `${label}: ${l.name}`).toBe(l.want);
          expect(new Date(r!.lastTouch!.at).toISOString(), `${label} at: ${l.name}`).toBe(when);
        }
      };
      const ids = leads.map((l) => l.id);
      for (let rep = 0; rep < 3; rep += 1) {
        const whole = (await db.query('select facts from public.my_leads_work_classified($1,$2,$3)', [org, sam, iso])).rows.map((r) => r.facts as F);
        check(whole, ids, `whole queue #${rep}`);
        const pageRows: F[] = [];
        for (const page of [1, 2, 3]) {
          const r = await as(() => db.query('select public.fn_my_leads_work_page($1,$2,$3,null,null,null,$4,20,$5) as r', [org, sam, 'all', page, iso]));
          pageRows.push(...(r.rows[0].r.rows as F[]));
        }
        check(pageRows, ids, `page #${rep}`);
        for (const id of ids) {
          const r = await as(() => db.query('select public.fn_my_leads_work_facts($1,$2,$3::uuid[],$4) as r', [org, sam, [id], iso]));
          check(r.rows[0].r.rows as F[], [id], `facts singleton #${rep}`);
        }
        const subsets = [ids.filter((_x, i) => i % 2 === rep % 2), ids.slice().reverse().slice(0, 7), [randomUUID(), ...ids.slice(rep * 5, rep * 5 + 9)]];
        for (const sub of subsets) {
          const r = await as(() => db.query('select public.fn_my_leads_work_facts($1,$2,$3::uuid[],$4) as r', [org, sam, sub, iso]));
          check(r.rows[0].r.rows as F[], sub.filter((x) => ids.includes(x)), `facts subset #${rep}`);
        }
        const part = (await db.query('select facts from public.my_leads_work_classified_ids($1,$2,$3,$4::uuid[])', [org, sam, iso, ids])).rows.map((r) => r.facts as F);
        check(part, ids, `classified_ids #${rep}`);
      }
      // The harness compared every read above against the baseline; this fixture must have needed the tie exemption.
      expect(stats.tieExempt - exemptBefore).toBeGreaterThan(0);
    } finally { await db.query('rollback').catch(() => {}); await db.end(); }
  }, 600_000);
});

afterAll(() => {
  const out = mkdtempSync(join(tmpdir(), 'parity-'));
  writeFileSync(join(out, 'stats.json'), JSON.stringify(stats));
  console.log(`[parity] compared=${stats.compared} tieExempt=${stats.tieExempt} errorsCompared=${stats.errorsCompared} mutationsSkipped=${stats.mutationsSkipped} earlierStates=${stats.earlierStates} byFn=${JSON.stringify(stats.byFn)}`);
});
