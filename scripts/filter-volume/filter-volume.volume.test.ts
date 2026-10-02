/* eslint-disable @typescript-eslint/no-explicit-any -- builders are duck-typed */
/**
 * PR A volume gate (stress plan #9): the computed-field filter translator vs a
 * frozen copy of the legacy translator, measured as complete authenticated
 * PostgREST requests (rows + exact count + filters + sort) on the unsearched
 * page of a ~50k-property dataset, in the SAME run on the SAME stack.
 *
 * Opt-in and local-only:
 *   FILTER_VOLUME=1 npx vitest run --config vitest.filter-volume.config.ts
 * against the disposable stack in scripts/filter-volume/README.md.
 *
 * Seeds ~50k properties / ~60k contacts / ~250k messages (20 leads x 5k
 * messages), ~55k tags, ~95k list rows, tasks. Uses PostgREST db-max-rows
 * 1000 and the `authenticated` role's 8s statement_timeout (verified, not
 * assumed). Budget: new p95 <= 2x legacy p95 per case.
 */
import { createHmac, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { createClient } from "@supabase/supabase-js";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyFilters, filterSelectFragment } from "@/lib/prospects/filter-to-supabase";
import type { FilterBlock } from "@/lib/prospects/filter-schema";
import { assertLocalOnlyEnvironment } from "@/lib/testing/local-only-guard";
import {
  applyFilters as legacyApply,
  filterSelectFragment as legacyFragment,
} from "@tests/integration/fixtures/legacy-filter-to-supabase.frozen";

assertLocalOnlyEnvironment();
const RUN = process.env.FILTER_VOLUME === "1";
const ORG = "00000000-0000-0000-0000-000000000bbb";
const MARKET = "VOL";
const N_PROPS = 50_000;
const SAMPLES = Number(process.env.FILTER_VOLUME_SAMPLES ?? 12);
const RESULTS = path.resolve(__dirname, "results");

let pg: PgClient;
let client: any;
const ids = { tags: [] as string[], lists: [] as string[] };

function mintJwt(sub: string): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub, role: "authenticated", aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 7200 });
  const sig = createHmac("sha256", process.env.FILTER_LOCAL_JWT_SECRET!).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

async function seed() {
  try {
    await seedInner();
  } catch (e) {
    await pg.query("rollback").catch(() => undefined);
    throw e;
  }
}

async function seedInner() {
  const { rows: existing } = await pg.query(`select count(*)::int n from public.properties where market = $1`, [MARKET]);
  if (existing[0].n >= N_PROPS && process.env.FILTER_VOLUME_RESEED !== "1") return;
  const userId = randomUUID();
  await pg.query("begin");
  await pg.query(`set session_replication_role = replica`);
  await pg.query(`insert into public.organizations (id, name) values ($1, 'BMH Group') on conflict do nothing`, [ORG]);
  await pg.query(`insert into auth.users (id, email, aud, role) values ($1, $2, 'authenticated', 'authenticated')`, [userId, `vol-${userId}@example.test`]);
  await pg.query(`insert into public.memberships (user_id, org_id, role) values ($1, $2, 'owner')`, [userId, ORG]);
  await pg.query(`create temp table vp as select n, gen_random_uuid() id from generate_series(0, ${N_PROPS - 1}) n`);
  await pg.query(`create temp table vc as select n, gen_random_uuid() id from generate_series(0, 59999) n`);
  await pg.query(`insert into public.contacts (id, org_id, first_name, last_name, phone_1) select id, '${ORG}', 'F' || n, 'L' || (n % 900), '816' || lpad(n::text, 7, '0') from vc`);
  await pg.query(`insert into public.properties (id, org_id, address, state, status, market, homeowner_contact_id)
    select p.id, '${ORG}', p.n || ' Vol St', 'MO', 'prospect', '${MARKET}', c.id from vp p join vc c on c.n = p.n % 60000`);
  // Messages: 20 heavy leads x 5000, plus 150k spread over 25k properties.
  await pg.query(`insert into public.messages (org_id, property_id, channel, direction, body, read_at, created_at)
    select '${ORG}', p.id, 'sms', case when g % 3 = 0 then 'inbound' else 'outbound' end, 'm',
           case when g % 3 = 0 and g % 50 <> 0 then now() else null end, now() - (g || ' minutes')::interval
      from vp p cross join generate_series(1, 5000) g where p.n < 20`);
  await pg.query(`insert into public.messages (org_id, property_id, channel, direction, body, read_at, created_at)
    select '${ORG}', p.id, 'sms', case when p.n % 3 = 0 and k % 2 = 0 then 'inbound' else 'outbound' end, 'm',
           case when p.n % 3 = 0 and k % 2 = 0 and k % 40 <> 0 then now() else null end, now() - (k || ' minutes')::interval
      from generate_series(1, 150000) k join vp p on p.n = 20 + ((k::bigint * 7919) % 25000)`);
  // Tags / lists / tasks.
  for (let i = 0; i < 5; i++) {
    const { rows } = await pg.query(`insert into public.tags (org_id, name, category) values ($1, $2, 'custom') returning id`, [ORG, `vol-tag-${i}-${userId}`]);
    ids.tags.push(rows[0].id);
  }
  for (let i = 0; i < 10; i++) {
    const { rows } = await pg.query(`insert into public.lists (org_id, name) values ($1, $2) returning id`, [ORG, `vol-list-${i}-${userId}`]);
    ids.lists.push(rows[0].id);
  }
  const tagRules = [`p.n % 2 = 0`, `p.n % 5 = 0`, `p.n < 20000`, `p.n % 97 = 0`, `p.n >= 49000`];
  for (let i = 0; i < 5; i++)
    await pg.query(`insert into public.property_tags (org_id, property_id, tag_id) select '${ORG}', p.id, '${ids.tags[i]}' from vp p where ${tagRules[i]}`);
  for (let i = 0; i < 10; i++)
    await pg.query(`insert into public.property_lists (org_id, property_id, list_id) select '${ORG}', p.id, '${ids.lists[i]}' from vp p where p.n % ${i + 2} = 0`);
  await pg.query(`insert into public.tasks (org_id, assignee_id, created_by, related_property_id, type, status, title, due_at)
    select '${ORG}', '${userId}', '${userId}', p.id, 'follow_up', case when p.n % 6 = 0 then 'open' else 'completed' end, 't', now() from vp p where p.n % 6 = 0 or p.n % 9 = 0`);
  await pg.query(`update public.properties set outreach_dispo = case when n_ % 40 = 0 then 'opted_out' when n_ % 53 = 0 then 'dnc' when n_ % 11 = 0 then 'nurture' end
    from (select id, n n_ from vp) v where properties.id = v.id and (n_ % 40 = 0 or n_ % 53 = 0 or n_ % 11 = 0)`);
  await pg.query(`set session_replication_role = origin`);
  await pg.query("commit");
  // Seeded with triggers off: populate the cache exactly like the migration's backfill.
  const t0 = Date.now();
  await pg.query(`do $b$ declare batch uuid[]; begin
    for batch in select array_agg(s.id) from (select id, (row_number() over (order by id) - 1) / 5000 g from public.properties) s group by s.g order by s.g
    loop perform public.refresh_property_filter_cache(batch); end loop; end $b$`);
  fs.mkdirSync(RESULTS, { recursive: true });
  fs.writeFileSync(path.join(RESULTS, "backfill.json"), JSON.stringify({ properties: N_PROPS, backfillMs: Date.now() - t0 }));
  for (const t of ["properties", "contacts", "messages", "tasks", "property_tags", "property_lists"]) await pg.query(`analyze public.${t}`);
  fs.mkdirSync(RESULTS, { recursive: true });
  fs.writeFileSync(path.join(RESULTS, "user.json"), JSON.stringify({ userId }));
}

const blk = (b: Record<string, unknown>): FilterBlock => ({ id: randomUUID(), ...b }) as any;
type Case = { name: string; blocks: () => FilterBlock[] };
function cases(): Case[] {
  const [T0, T1] = ids.tags;
  const [L0, L1, L2] = ids.lists;
  return [
    { name: "unfiltered", blocks: () => [] },
    { name: "engagement any replied", blocks: () => [blk({ kind: "engagement", combinator: "any", values: ["replied"] })] },
    { name: "engagement any attempted", blocks: () => [blk({ kind: "engagement", combinator: "any", values: ["attempted"] })] },
    { name: "engagement any never_contacted", blocks: () => [blk({ kind: "engagement", combinator: "any", values: ["never_contacted"] })] },
    { name: "engagement not replied (negative)", blocks: () => [blk({ kind: "engagement", combinator: "not", values: ["replied"] })] },
    { name: "engagement any replied+opted_out", blocks: () => [blk({ kind: "engagement", combinator: "any", values: ["replied", "opted_out"] })] },
    { name: "engagement not opted_out (negative)", blocks: () => [blk({ kind: "engagement", combinator: "not", values: ["opted_out"] })] },
    { name: "has_unread_inbound yes", blocks: () => [blk({ kind: "has_unread_inbound", tri: "yes" })] },
    { name: "has_unread_inbound no (negative)", blocks: () => [blk({ kind: "has_unread_inbound", tri: "no" })] },
    { name: "has_open_tasks yes", blocks: () => [blk({ kind: "has_open_tasks", tri: "yes" })] },
    { name: "has_open_tasks no (negative)", blocks: () => [blk({ kind: "has_open_tasks", tri: "no" })] },
    { name: "tag any", blocks: () => [blk({ kind: "tag", combinator: "any", values: [T0] })] },
    { name: "tag all two", blocks: () => [blk({ kind: "tag", combinator: "all", values: [T0, T1] })] },
    { name: "tag not (negative)", blocks: () => [blk({ kind: "tag", combinator: "not", values: [T0] })] },
    { name: "list any", blocks: () => [blk({ kind: "list", combinator: "any", values: [L0] })] },
    { name: "list all three", blocks: () => [blk({ kind: "list", combinator: "all", values: [L0, L1, L2] })] },
    { name: "list not (negative)", blocks: () => [blk({ kind: "list", combinator: "not", values: [L0] })] },
    { name: "list_count min 3", blocks: () => [blk({ kind: "list_count", range: { min: 3, max: null } })] },
    { name: "list_count max 1 (negative-ish)", blocks: () => [blk({ kind: "list_count", range: { min: null, max: 1 } })] },
    { name: "combined: replied + unread + tag + open tasks", blocks: () => [
      blk({ kind: "engagement", combinator: "any", values: ["replied"] }), blk({ kind: "has_unread_inbound", tri: "yes" }),
      blk({ kind: "tag", combinator: "any", values: [T0] }), blk({ kind: "has_open_tasks", tri: "yes" })] },
    { name: "combined negative: not replied + no unread + not tag + no tasks", blocks: () => [
      blk({ kind: "engagement", combinator: "not", values: ["replied"] }), blk({ kind: "has_unread_inbound", tri: "no" }),
      blk({ kind: "tag", combinator: "not", values: [T0] }), blk({ kind: "has_open_tasks", tri: "no" })] },
    { name: "combined: outreach_dispo not nurture + attempted + list any", blocks: () => [
      blk({ kind: "outreach_dispo", combinator: "not", values: ["nurture"] }), blk({ kind: "engagement", combinator: "any", values: ["attempted"] }),
      blk({ kind: "list", combinator: "any", values: [L1] })] },
  ];
}

async function request(translator: any, fragment: any, blocks: FilterBlock[]) {
  const frag = fragment(blocks);
  const sel = frag ? `id, address, ${frag}` : "id, address";
  let q = client.from("properties").select(sel, { count: "exact" }).eq("market", MARKET).is("deleted_at", null);
  q = (await translator(q, blocks, client)).builder;
  const t0 = performance.now();
  const { error, count, data } = await q.order("id").range(0, 24);
  const ms = performance.now() - t0;
  return { ms, error: error ? `${error.code ?? ""} ${error.message}`.trim() : null, count: count as number | null, rows: data?.length ?? 0 };
}
const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(0.95 * xs.length) - 1];

beforeAll(async () => {
  if (!RUN) return;
  pg = new PgClient({ connectionString: process.env.TEST_SUPABASE_DB_URL! });
  await pg.connect();
  const { rows: ver } = await pg.query(`show server_version`);
  const { rows: to } = await pg.query(`select rolconfig from pg_roles where rolname = 'authenticated'`);
  expect(JSON.stringify(to[0].rolconfig)).toContain("statement_timeout=8s");
  fs.mkdirSync(RESULTS, { recursive: true });
  await seed();
  const { rows: tg } = await pg.query(`select id from public.tags where name like 'vol-tag-%' order by name`);
  const { rows: ls } = await pg.query(`select id from public.lists where name like 'vol-list-%' order by name`);
  ids.tags = tg.map((r) => r.id);
  ids.lists = ls.map((r) => r.id);
  const userId = JSON.parse(fs.readFileSync(path.join(RESULTS, "user.json"), "utf8")).userId;
  client = createClient(process.env.TEST_SUPABASE_URL!, process.env.TEST_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${mintJwt(userId)}` } },
  });
  fs.writeFileSync(path.join(RESULTS, "env.json"), JSON.stringify({ serverVersion: ver[0].server_version, authenticatedRoleConfig: to[0].rolconfig, samples: SAMPLES }, null, 2));
}, 1_800_000);

afterAll(async () => { await pg?.end(); });

describe.runIf(RUN)("PR A volume gate: computed fields vs frozen legacy translator", () => {
  it("measures every case, same run, same stack", async () => {
    const rows: any[] = [];
    for (const c of cases()) {
      const out: any = { name: c.name };
      for (const [label, tr, fr] of [["legacy", legacyApply, legacyFragment], ["new", applyFilters, filterSelectFragment]] as const) {
        const blocks = c.blocks();
        await request(tr, fr, blocks); // warm-up
        const times: number[] = [];
        let last: any = null;
        for (let i = 0; i < SAMPLES; i++) {
          last = await request(tr, fr, blocks);
          if (last.error) break;
          times.push(last.ms);
        }
        out[label] = last.error ? { error: last.error } : { p95: Math.round(p95(times)), median: Math.round(times.sort((a, b) => a - b)[Math.floor(times.length / 2)]), count: last.count };
      }
      out.ratio = out.new.p95 != null && out.legacy.p95 != null ? +(out.new.p95 / out.legacy.p95).toFixed(2) : null;
      // Strict: new p95 <= 2x legacy p95. If legacy errors (414 URI too long) or
      // returns a DIFFERENT (i.e. wrong, truncated) count than the correct
      // result, it is not a valid baseline: those cases are reported as
      // baselineInvalid and held to an absolute bound instead.
      out.baselineInvalid = Boolean(out.legacy.error) || out.legacy.count !== out.new.count;
      out.withinBudget = out.new.error ? false : out.baselineInvalid ? null : out.new.p95 <= 2 * out.legacy.p95;
      out.absoluteOk = out.new.error ? false : out.new.p95 <= 250;
      rows.push(out);
      console.log(JSON.stringify(out));
    }
    fs.writeFileSync(path.join(RESULTS, "latest.json"), JSON.stringify(rows, null, 2));
    expect(rows.filter((r) => r.new.error)).toEqual([]);
    expect(rows.filter((r) => r.withinBudget === false).map((r) => r.name)).toEqual([]);
    expect(rows.filter((r) => !r.absoluteOk).map((r) => r.name)).toEqual([]);
  }, 3_600_000);

  it("plans: auto_explain (log_nested_statements) and pg_stat_statements (track=all) for representative cases (no nested lookups remain with cache columns)", async () => {
    const adminUrl = new URL(process.env.TEST_SUPABASE_DB_URL!);
    adminUrl.username = "supabase_admin";
    const admin = new PgClient({ connectionString: adminUrl.toString() });
    await admin.connect();
    await admin.query(`alter system set pg_stat_statements.track = 'all'`);
    await admin.query(`select pg_reload_conf()`);
    const report: string[] = [];
    const userId = JSON.parse(fs.readFileSync(path.join(RESULTS, "user.json"), "utf8")).userId;
    const claims = JSON.stringify({ sub: userId, role: "authenticated", aud: "authenticated" });
    const sqls: Record<string, string> = {
      engagement_replied: `select id from public.properties where market='VOL' and deleted_at is null and has_inbound_message order by id limit 25`,
      engagement_not_replied_count: `select count(*) from public.properties where market='VOL' and deleted_at is null and not has_inbound_message`,
      unread_yes: `select id from public.properties where market='VOL' and deleted_at is null and has_unread_inbound order by id limit 25`,
      tag_any: `select id from public.properties where market='VOL' and deleted_at is null and filter_tag_ids && array['${ids.tags[0]}']::uuid[] order by id limit 25`,
      list_count_min3: `select id from public.properties where market='VOL' and deleted_at is null and filter_list_count >= 3 order by id limit 25`,
    };
    const conn = new PgClient({ connectionString: adminUrl.toString() });
    await conn.connect();
    conn.on("notice", (n) => report.push(String(n.message)));
    await conn.query(`load 'auto_explain'`);
    await conn.query(`set auto_explain.log_min_duration = 0; set auto_explain.log_nested_statements = on; set auto_explain.log_analyze = on; set auto_explain.log_buffers = on; set client_min_messages = log`);
    await conn.query(`set role authenticated`);
    await conn.query(`select set_config('request.jwt.claims', $1, false)`, [claims]);
    for (const [name, sql] of Object.entries(sqls)) {
      report.push(`===== ${name} =====`);
      await admin.query(`select pg_stat_statements_reset()`);
      await conn.query(sql);
      const { rows } = await admin.query(
        `select calls, round(total_exec_time::numeric,1) ms, shared_blks_hit + shared_blks_read buffers, left(query, 140) q
           from pg_stat_statements where query not ilike '%pg_stat_statements%' and query not ilike 'set %' and query not ilike 'select set_config%'
           order by shared_blks_hit + shared_blks_read desc limit 6`,
      );
      report.push(`pg_stat_statements (track=all) top by buffers: ${JSON.stringify(rows)}`);
    }
    await conn.end();
    await admin.end();
    fs.writeFileSync(path.join(RESULTS, "nested-plans.txt"), report.join("\n"));
    expect(report.join("\n")).toMatch(/Seq Scan|Index/);
  }, 600_000);
});
