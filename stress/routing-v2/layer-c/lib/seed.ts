import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type { Client } from "pg";

import { APPROVED_REPLY_TEXTS } from "@/lib/ai-responder/approved-reply-texts";
import { V2_REPLY_TEXTS, V2_TEMPLATE_KEYS } from "@/lib/sms-classification/routing-v2/reply-texts";

/**
 * Per-run org + canary leads on the stress stack. Every row is in a fresh org named
 * `stress-rv2 <runId>` (the run tag), so re-runs never collide and cleanup is org-scoped.
 *
 * Drips: the v2 drips are created by re-running the cutover migrations' own seed blocks
 * (20261030181000 §5, 20261030270000) scoped to this org. Those blocks copy LEGACY source drips
 * that exist only in production (Book appointment steps >= 7, Listed not selling, Maybe later,
 * Not interested, Asked who is texting, Confirmed owner); this stack has none, so the harness
 * creates placeholder sources whose bodies read "[stress placeholder <drip> step N]". They are
 * test fixtures on a disposable stack (mock SMS only), never approved copy, and are excluded
 * from the §4.2 length check.
 */
const ROOT = path.resolve(__dirname, "../../../..");

/** Resolve a migration by its name, not its version: round 17 re-timestamps the routing v2
 *  migrations (pure renames), so a hard-coded version would break. Exactly one match required. */
export function migrationByName(name: string): string {
  const dir = path.join(ROOT, "supabase/migrations");
  const hits = readdirSync(dir).filter((f) => f.endsWith(`_${name}.sql`) && !f.includes("integration"));
  if (hits.length !== 1) throw new Error(`migration ${name}: expected exactly one file, found ${hits.length}`);
  return path.join(dir, hits[0]!);
}

export const PLACEHOLDER_SOURCES: Record<string, number> = {
  "Book appointment": 9, "Listed, not selling": 3, "Maybe later": 3, "Not interested": 3,
  "Asked who is texting": 3, "Confirmed owner": 3,
};

export type RunOrg = { orgId: string; runId: string; sender: string };
export type Lead = { propertyId: string; contactId: string; phone: string; state: string; address: string; idx: number };

/**
 * The inbound webhook inserts messages without org_id, so they take the column default (the BMH
 * org 0…0bbb) — see report. A fresh org would therefore never match its own inbound rows, so every
 * run uses the BMH org of this disposable stack, with its own sender number and run-tagged leads
 * (contacts.last_name = 'stress-<runId>'). Config/templates/drips are ensured idempotently.
 */
export const BMH = "00000000-0000-0000-0000-000000000bbb";
export async function createRunOrg(pg: Client, runId: string, flags: Record<string, unknown>): Promise<RunOrg> {
  const orgId = BMH;
  const sender = `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
  await pg.query(
    `insert into public.provider_sender_numbers (org_id, provider, phone_e164, status, last_synced_at, updated_at)
     values ($1, 'mock', $2, 'active', now(), now())`, [orgId, sender]);
  // Owner-only guard trigger: the fixture writes the config the way the owner RPC would.
  await pg.query("begin");
  await pg.query("set local session_replication_role = replica");
  await pg.query(
    `update public.ai_responder_configs set business_hours_only = false, classifier_provider = 'jev', classifier_mode = 'automatic',
       classifier_engine = 'nine_questions', reply_delay_min_seconds = 30, reply_delay_max_seconds = 60, routing_v2_flags = $2
     where org_id = $1 and active`, [orgId, JSON.stringify(flags)]);
  await pg.query("commit");
  for (const outcome of ["nurture", "not_interested", "wrong_number", "new_lead"]) {
    await pg.query(`insert into public.jev_outcome_thresholds (org_id, outcome, min_confidence, automation_enabled) values ($1, $2, 0.9, true)
      on conflict do nothing`, [orgId, outcome]);
    await pg.query("update public.jev_outcome_thresholds set automation_enabled = true where org_id = $1 and outcome = $2", [orgId, outcome]);
  }
  const texts: Array<[string, string]> = [
    ...V2_TEMPLATE_KEYS.map((k) => [k, V2_REPLY_TEXTS[k]] as [string, string]),
    ["number_source", V2_REPLY_TEXTS.number_source],
    ["nurture", APPROVED_REPLY_TEXTS.nurture], ["not_interested", APPROVED_REPLY_TEXTS.not_interested],
    ["wrong_number", APPROVED_REPLY_TEXTS.wrong_number],
  ];
  await pg.query("begin");
  await pg.query("select set_config('sandra.template_approval', 'on', true)");
  for (const [outcome, content] of texts) {
    const have = await pg.query("select 1 from public.auto_reply_templates where org_id = $1 and outcome = $2", [orgId, outcome]);
    if (have.rowCount) continue;
    const { rows } = await pg.query(
      "insert into public.sms_templates (org_id, name, content, approved_for_auto_send, approved_content, approved_at) values ($1, $2, $3, true, $3, now()) returning id",
      [orgId, `stress ${outcome}`, content]);
    await pg.query("insert into public.auto_reply_templates (org_id, outcome, template_id) values ($1, $2, $3)", [orgId, outcome, rows[0].id]);
  }
  await pg.query("commit");
  await seedDrips(pg, orgId);
  return { orgId, runId, sender };
}

async function seedDrips(pg: Client, orgId: string): Promise<void> {
  for (const [name, n] of Object.entries(PLACEHOLDER_SOURCES)) {
    const exists = await pg.query("select 1 from public.sequences where org_id = $1 and name = $2", [orgId, name]);
    if (exists.rowCount) continue;
    const { rows } = await pg.query("insert into public.sequences (org_id, name, active) values ($1, $2, true) returning id", [orgId, name]);
    for (let i = 0; i < n; i++) {
      await pg.query(
        "insert into public.sequence_steps (sequence_id, step_index, delay_after_previous_minutes, action_type, template_body) values ($1, $2, $3, 'send_sms', $4)",
        [rows[0].id, i, i === 0 ? 0 : 1440, `[stress placeholder ${name} step ${i + 1}]`]);
    }
  }
  const m181 = readFileSync(migrationByName("routing_v2_versioned_drips"), "utf8").split("\n");
  const start = m181.findIndex((l) => l.startsWith("drop table if exists routing_v2_seed"));
  let end = start;
  while (!m181[end]!.startsWith("end $$;")) end++;
  const seed181 = m181.slice(start, end + 1).join("\n");
  const m270 = readFileSync(migrationByName("routing_v2_legacy_drip_snapshots"), "utf8");
  const seed270 = m270.slice(m270.indexOf("do $$"), m270.lastIndexOf("end $$;") + "end $$;".length);
  const scope = (sql: string) => {
    const out = sql.replace("select distinct org_id from public.ai_responder_configs", `select distinct org_id from public.ai_responder_configs where org_id = '${orgId}'`);
    if (out === sql) throw new Error("seed scope marker not found");
    return out;
  };
  await pg.query("begin");
  await pg.query("set local routing_v2.allow_drip_edit = 'on'");
  await pg.query(scope(seed181));
  await pg.query(scope(seed270));
  await pg.query("commit");
}

/** Reply quiet hours use the phone's area code; drip quiet hours / slot times use property state. */
export const AREA: Record<string, string> = { PR: "787", GU: "671", HI: "808", MO: "816", KS: "913", OH: "614", CO: "303", CA: "213", "": "816" };
const STATES: Array<{ state: string; fips: string | null; w: number }> = [
  { state: "MO", fips: null, w: 60 }, { state: "KS", fips: "20091", w: 20 }, { state: "OH", fips: null, w: 5 },
  { state: "CO", fips: null, w: 5 }, { state: "CA", fips: null, w: 5 }, { state: "", fips: null, w: 5 },
];
export function stateFor(i: number): { state: string; fips: string | null } {
  let x = i % 100;
  for (const s of STATES) { if (x < s.w) return s; x -= s.w; }
  return STATES[0]!;
}

/** Bulk-seed leads: contact + opt-in consent + property + one delivered outbound campaign text. */
export async function seedLeads(pg: Client, org: RunOrg, n: number, opts: {
  ourLast?: (i: number) => string; state?: (i: number) => { state: string; fips: string | null };
  address?: (i: number) => string; firstName?: (i: number) => string | null; phoneBase?: number; testRunId?: string; phone?: (i: number) => string;
} = {}): Promise<Lead[]> {
  const base = opts.phoneBase ?? 2_000_000 + Math.floor(Math.random() * 5_000_000);
  const leads: Lead[] = [];
  const chunk = 300;
  for (let s = 0; s < n; s += chunk) {
    const ids = Array.from({ length: Math.min(chunk, n - s) }, (_, k) => s + k);
    const rows = ids.map((i) => {
      const st = (opts.state ?? stateFor)(i);
      return { i, phone: opts.phone?.(i) ?? `+1${AREA[st.state] ?? "816"}${base + i}`, contactId: randomUUID(), propertyId: randomUUID(), st,
        address: opts.address?.(i) ?? `${100 + i} Stress Run Ave`, first: opts.firstName ? opts.firstName(i) : "Pat" };
    });
    await pg.query(
      `insert into public.contacts (id, org_id, first_name, last_name, phone_1, phone_1_type)
       select id, $1::uuid, f, $5, p, 'mobile' from unnest($2::uuid[], $3::text[], $4::text[]) as t(id, f, p)`,
      [org.orgId, rows.map((r) => r.contactId), rows.map((r) => r.first), rows.map((r) => r.phone), `stress-${org.runId}`]);
    await pg.query(
      `insert into public.consent_events (contact_id, channel, event_type, source, org_id)
       select unnest($2::uuid[]), 'sms', 'opt_in_marketing_written', 'stress-rv2', $1`, [org.orgId, rows.map((r) => r.contactId)]);
    await pg.query(
      `insert into public.properties (id, org_id, address, city, state, zip, fips_code, status, homeowner_contact_id)
       select id, $1, a, 'Kansas City', st, '64111', f, 'prospect', c from unnest($2::uuid[], $3::text[], $4::text[], $5::text[], $6::uuid[]) as t(id, a, st, f, c)`,
      [org.orgId, rows.map((r) => r.propertyId), rows.map((r) => r.address), rows.map((r) => r.st.state), rows.map((r) => r.st.fips), rows.map((r) => r.contactId)]);
    await pg.query(
      `insert into public.messages (org_id, channel, direction, status, property_id, contact_id, from_address, to_address, body, created_at)
       select $1, 'sms', 'outbound', 'delivered', p, c, $2, ph, b, now() - interval '3 hours' from unnest($3::uuid[], $4::uuid[], $5::text[], $6::text[]) as t(p, c, ph, b)`,
      [org.orgId, org.sender, rows.map((r) => r.propertyId), rows.map((r) => r.contactId), rows.map((r) => r.phone),
        rows.map((r) => opts.ourLast?.(r.i) ?? `Hi, would you consider an offer on ${r.address}?`)]);
    if (opts.testRunId) await pg.query("update public.properties set test_run_id = $1 where id = any($2)", [opts.testRunId, rows.map((r) => r.propertyId)]);
    for (const r of rows) leads.push({ propertyId: r.propertyId, contactId: r.contactId, phone: r.phone, state: r.st.state, address: r.address, idx: r.i });
  }
  return leads;
}

/** Delete every row of this run's org (org-scoped tables), as the repo's temp-org fixtures do. */
export async function cleanupOrg(pg: Client, orgId: string): Promise<void> {
  const { rows } = await pg.query<{ table_name: string }>(
    "select c.table_name from information_schema.columns c join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name where c.table_schema = 'public' and c.column_name = 'org_id' and t.table_type = 'BASE TABLE'");
  await pg.query("begin");
  await pg.query("set local session_replication_role = replica");
  for (const { table_name } of rows) {
    if (table_name === "organizations") continue;
    await pg.query(`delete from public."${table_name}" where org_id = $1`, [orgId]);
  }
  await pg.query("delete from public.organizations where id = $1", [orgId]);
  await pg.query("commit");
}

/** Prior runs' still-pending outbox rows (all on this disposable stack are this harness's own) are retired. */
export async function retirePriorRuns(pg: Client): Promise<number> {
  const r = await pg.query("update public.routing_v2_outbox set status = 'cancelled', cancel_reason = 'stress_prior_run' where status in ('pending','claimed')");
  await pg.query("update public.sequence_enrollments set status = 'completed', next_run_at = null where status in ('active','paused') and org_id = $1", [BMH]);
  return r.rowCount ?? 0;
}

export async function setFlags(pg: Client, orgId: string, flags: Record<string, unknown>): Promise<void> {
  await pg.query("update public.ai_responder_configs set routing_v2_flags = $2 where org_id = $1", [orgId, JSON.stringify(flags)]);
}

/**
 * Skew-0 quiet-hours fixture: a lead in Pacific/Honolulu (area 808, state HI) is in recipient quiet hours while the
 * real clock is 21:00-08:00 HST. To let a queued reply become deliverable WITHOUT moving any clock, the lead is
 * re-addressed to an in-hours (816, MO) number: contact phone + the property's inbound from_address are rewritten.
 */
export async function readdressToInHours(pg: Client, lead: Lead): Promise<string> {
  const phone = `+1816${String(2_000_000 + Math.floor(Math.random() * 7_000_000))}`;
  await pg.query("update public.contacts set phone_1 = $1 where id = $2", [phone, lead.contactId]);
  await pg.query("update public.messages set from_address = $1 where property_id = $2 and direction = 'inbound'", [phone, lead.propertyId]);
  await pg.query("update public.messages set to_address = $1 where property_id = $2 and direction = 'outbound'", [phone, lead.propertyId]);
  await pg.query("update public.properties set state = 'MO' where id = $1", [lead.propertyId]);
  lead.phone = phone; lead.state = "MO";
  return phone;
}
export const QUIET_ZONE = { state: "HI", fips: null as string | null, tz: "Pacific/Honolulu" };

/** Quiet fixture zone, chosen per run (QUIET_STATE env): GU (Pacific/Guam) or PR (America/Puerto_Rico). Never a clock move. */
export const QUIET_TZ_BY_STATE: Record<string, string> = { GU: "Pacific/Guam", PR: "America/Puerto_Rico", HI: "Pacific/Honolulu" };
export const QS = process.env.QUIET_STATE ?? "GU";
export const QA = AREA[QS]!;
export const QT = QUIET_TZ_BY_STATE[QS]!;
