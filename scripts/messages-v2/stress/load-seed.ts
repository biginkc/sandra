import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createClient } from "@supabase/supabase-js";
import { Client } from "pg";

import { assertLocalOnlyTestEnv } from "@/lib/testing/local-only-test-env";

import { snapshot } from "./cleanup";
import { assertStressDbEnv } from "./core";
import { assertCanaryOrg, assertRunId, BMH_ORG_ID, CANARY_ORG_ID, runTag, seedBystanders } from "./d-lane-fixture";

/**
 * Messages v2 Stage 5, Run 4 (UI load), D LANE seeder. Disposable stack only (assertStressDbEnv).
 *
 * Writes, in the canary-style org, every row tagged `STRESS <runId>`:
 *   - 5,000 open holds: flagged properties (needs_human_attention, not DNC locked), reasons spread over the real
 *     reason set, each with a UNIQUE flag time (one per second) so the page's waiting cards can be matched 1:1;
 *   - 2,000 pipeline runs (3 steps each) inside ONE America/Chicago day (yesterday, 08:00-20:00), each on its own
 *     property with an inbound text whose body carries a unique token `R00001`..`R02000`.
 * Plus an active owner login for the browser check (owner of the canary org; plain member of BMH's org, which the
 * app's middleware requires for any page) (password written 0600 to <out>/load-owner.json, never printed).
 * The Run 7 "before" snapshot is taken BEFORE any row is written.
 *
 *   MV2_STRESS_RUN_ID (default ui-<epoch>)  MV2_STRESS_HOLDS (5000)  MV2_STRESS_RUNS (2000)  MV2_STRESS_OUT_DIR
 * Run: npm run stress:messages-v2:load-seed
 */
export const HOLD_REASONS = [
  "hot_lead",
  "nine_asked_stop",
  "nine_hostile",
  "nine_needs_person",
  "jev_unclear_no_action",
  "keyword:legal_contract",
  "keyword:numeric_amount",
  "keyword:handoff_request",
  "nine_reply_not_sent:automation_disabled",
  "nine_reply_not_sent:outbound_mode_hold",
  "nine_automation_disabled:wrong_number",
  "model:unclear",
] as const;

/** America/Chicago calendar day before `now`, as YYYY-MM-DD. */
export function chicagoYesterday(now = Date.now()): string {
  return new Date(now - 86_400_000).toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

export async function seedLoad(pg: Client, opts: { runId: string; holds: number; runs: number; day: string }) {
  const { runId, holds, runs, day } = opts;
  assertRunId(runId);
  assertCanaryOrg(CANARY_ORG_ID);
  const tag = runTag(runId);
  await pg.query("begin");
  try {
    // Holds: contacts + flagged properties. Flag times: one per second, ending an hour before the run day starts.
    await pg.query(
      `with c as (
         insert into public.contacts (org_id, first_name, last_name, phone_1, phone_1_type)
         select $1, 'H' || lpad(g::text, 5, '0'), $2, '+1913' || lpad((5000000 + g)::text, 7, '0'), 'mobile'
         from generate_series(1, $3) g
         returning id, first_name)
       insert into public.properties (org_id, address, state, status, homeowner_contact_id, needs_human_attention, needs_human_attention_since, last_ai_escalation_at, last_ai_escalation_reason)
       select $1, $2 || ' ' || c.first_name || ' Oak St', 'MO', 'prospect', c.id, true,
              ($5::date::timestamp at time zone 'America/Chicago') - interval '1 hour' - (substr(c.first_name, 2)::int * interval '1 second'),
              ($5::date::timestamp at time zone 'America/Chicago') - interval '1 hour' - (substr(c.first_name, 2)::int * interval '1 second'),
              ($4::text[])[1 + (substr(c.first_name, 2)::int % array_length($4::text[], 1))]
       from c`,
      [CANARY_ORG_ID, tag, holds, HOLD_REASONS, day],
    );
    // The insert trigger stamps needs_human_attention_since with clock_timestamp() (microseconds apart, so they
    // collide at the page's millisecond precision). Re-stamp it with the seeded one-per-second flag time so every
    // waiting card carries a unique, known time the check can match 1:1.
    await pg.query(
      "update public.properties set needs_human_attention_since = last_ai_escalation_at where org_id = $1 and needs_human_attention and starts_with(address, $2 || ' H')",
      [CANARY_ORG_ID, tag],
    );
    // Runs: contact + unflagged property + inbound text + run + 3 steps, inside 08:00-20:00 Chicago on `day`.
    await pg.query(
      `create temp table stress_runs on commit drop as
       select g, gen_random_uuid() as contact_id, gen_random_uuid() as property_id, gen_random_uuid() as message_id, gen_random_uuid() as run_id,
              ($2::date::timestamp at time zone 'America/Chicago') + interval '8 hours' + ((g - 1) * (interval '12 hours' / $1)) as at,
              'R' || lpad(g::text, 5, '0') as token
       from generate_series(1, $1::int) g`,
      [runs, day],
    );
    await pg.query(
      `insert into public.contacts (id, org_id, first_name, last_name, phone_1, phone_1_type)
       select contact_id, $1, token, $2, '+1913' || lpad((6000000 + g)::text, 7, '0'), 'mobile' from stress_runs`,
      [CANARY_ORG_ID, tag],
    );
    await pg.query(
      `insert into public.properties (id, org_id, address, state, status, homeowner_contact_id)
       select property_id, $1, $2 || ' ' || token || ' Elm St', 'MO', 'prospect', contact_id from stress_runs`,
      [CANARY_ORG_ID, tag],
    );
    await pg.query(
      `insert into public.messages (id, org_id, channel, direction, status, property_id, contact_id, from_address, to_address, body, created_at)
       select message_id, $1, 'sms', 'inbound', 'received', property_id, contact_id, '+1913' || lpad((6000000 + g)::text, 7, '0'), '+18165550000',
              'Not interested ' || $2 || ' ' || token, at
       from stress_runs`,
      [CANARY_ORG_ID, tag],
    );
    await pg.query(
      `insert into public.pipeline_runs (id, org_id, inbound_message_id, property_id, contact_id, conversation_id, status, mode, final_outcome, reason, inbound_preview, started_at, completed_at, created_at)
       select r.run_id, $1, r.message_id, r.property_id, r.contact_id, m.conversation_id, 'closed', 'automatic', 'not_interested', 'nine_questions:not_interested',
              'Not interested ' || $2 || ' ' || r.token, r.at, r.at + interval '2 seconds', r.at
       from stress_runs r join public.messages m on m.id = r.message_id`,
      [CANARY_ORG_ID, tag],
    );
    await pg.query(
      `insert into public.pipeline_run_steps (run_id, org_id, seq, kind, name, result, detail, created_at)
       select r.run_id, $1, s.seq, s.kind, s.name, s.result, '{}'::jsonb, r.at + (s.seq * interval '100 milliseconds')
       from stress_runs r
       cross join (values (1, 'jev', 'classify', 'pass'), (2, 'action', 'not_interested', 'applied'), (3, 'reply', 'template_reply', 'skipped')) as s(seq, kind, name, result)`,
      [CANARY_ORG_ID],
    );
    await pg.query("commit");
  } catch (e) {
    await pg.query("rollback");
    throw e;
  }
  return dbCounts(pg, runId, day);
}

/** The DB truth the page is compared against. */
export async function dbCounts(pg: Client, runId: string, day: string) {
  const tag = runTag(runId);
  const holds = await pg.query(
    "select count(*)::int c from public.properties where org_id = $1 and needs_human_attention and not is_dnc_locked and starts_with(address, $2 || ' ')",
    [CANARY_ORG_ID, tag],
  );
  const allHolds = await pg.query("select count(*)::int c from public.properties where org_id = $1 and needs_human_attention and not is_dnc_locked", [CANARY_ORG_ID]);
  const runs = await pg.query(
    `select count(*)::int c from public.pipeline_runs where org_id = $1 and starts_with(inbound_preview, 'Not interested ' || $2 || ' ')
       and started_at >= ($3::date::timestamp at time zone 'America/Chicago') and started_at < (($3::date + 1)::timestamp at time zone 'America/Chicago')`,
    [CANARY_ORG_ID, tag, day],
  );
  const allRuns = await pg.query("select count(*)::int c from public.pipeline_runs where org_id = $1", [CANARY_ORG_ID]);
  return { taggedHolds: holds.rows[0].c, orgHolds: allHolds.rows[0].c, taggedRunsOnDay: runs.rows[0].c, orgRuns: allRuns.rows[0].c };
}

async function main() {
  assertStressDbEnv(process.env);
  assertLocalOnlyTestEnv(process.env.TEST_SUPABASE_DB_URL, process.env.TEST_SUPABASE_URL);
  const runId = process.env.MV2_STRESS_RUN_ID ?? `ui-${Date.now()}`;
  const out = path.resolve(process.env.MV2_STRESS_OUT_DIR ?? "test-results/messages-v2-stress");
  const holds = Number(process.env.MV2_STRESS_HOLDS ?? "5000");
  const runs = Number(process.env.MV2_STRESS_RUNS ?? "2000");
  const day = process.env.MV2_STRESS_DAY ?? chicagoYesterday();
  mkdirSync(out, { recursive: true });
  const admin = createClient(process.env.TEST_SUPABASE_URL!, process.env.TEST_SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const pg = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
  await pg.connect();
  try {
    const { error: orgErr } = await admin.from("organizations").upsert({ id: CANARY_ORG_ID, name: "STRESS canary (messages v2, disposable)" });
    if (orgErr) throw new Error(`canary org upsert failed: ${orgErr.message}`);
    await seedBystanders(pg, runId);
    const before = await snapshot(pg, CANARY_ORG_ID, runId);
    writeFileSync(path.join(out, `cleanup-before-${runId}.json`), JSON.stringify(before, null, 1));
    // Browser login: an active OWNER of the canary org only (no other membership), on the domain the app admits.
    const email = `mv2-stress-owner-${runId.toLowerCase()}@bmhgroupkc.com`;
    const password = randomUUID() + randomUUID();
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, app_metadata: { purpose: "mv2-stress-ui-load" } });
    if (created.error || !created.data.user) throw new Error(`owner creation failed: ${created.error?.message}`);
    const { error: memErr } = await admin.from("memberships").insert({ user_id: created.data.user.id, org_id: CANARY_ORG_ID, role: "owner" });
    if (memErr) throw new Error(`owner membership failed: ${memErr.message}`);
    // The app's middleware admits only members of Sandra's org (SANDRA_ORG_ID = BMH's org id). A plain member row
    // there (not owner, no acquisitions) opens the app shell but NOT Messages v2 for BMH's org, so the page resolves
    // to the canary org, where this user is the owner (messagesV2OrgId).
    const { error: shellErr } = await admin.from("memberships").insert({ user_id: created.data.user.id, org_id: BMH_ORG_ID, role: "member" });
    if (shellErr) throw new Error(`app-shell membership failed: ${shellErr.message}`);
    writeFileSync(path.join(out, "load-owner.json"), JSON.stringify({ email, password, userId: created.data.user.id }), { mode: 0o600 });
    const t0 = Date.now();
    const counts = await seedLoad(pg, { runId, holds, runs, day });
    const seed = { lane: "D", runId, orgId: CANARY_ORG_ID, day, requested: { holds, runs }, counts, seedMs: Date.now() - t0, beforeSha256: before.sha256 };
    writeFileSync(path.join(out, "load-seed.json"), JSON.stringify(seed, null, 1));
    console.log(JSON.stringify(seed, null, 2));
    if (counts.taggedHolds !== holds || counts.taggedRunsOnDay !== runs) throw new Error("seeded counts differ from the request");
  } finally {
    await pg.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
