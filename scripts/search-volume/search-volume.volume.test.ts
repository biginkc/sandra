/* eslint-disable @typescript-eslint/no-explicit-any -- builders are duck-typed */
/**
 * Search volume gate (stress plan #9, Search). Opt-in, LOCAL disposable stack only:
 *   SEARCH_VOLUME=1 FILTER_LOCAL_DB_URL=... FILTER_LOCAL_API_URL=... \
 *     npx vitest run --config vitest.search-volume.config.ts
 *
 * Seeds ~50k properties / ~60k contacts / ~250k SMS with realistic skew (top surname
 * on ~2% of contacts, shared area codes, a word in ~5% of threads, 20 lead threads of
 * 5k messages). Measures COMPLETE authenticated PostgREST requests through the same
 * buildScopedQuery the page uses (rows + exact count + embeds + filters + sort), with
 * PostgREST max_rows=1000 and the authenticated 8s statement_timeout (verified).
 *
 * Budgets: page request p95 <= 1500 ms and <= 3x the same filters without search;
 * select-all up to the cap <= 10 s. Only deliberately pathological inputs may hit the
 * friendly timeout, never a 500.
 */
import { createHmac, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { createClient } from "@supabase/supabase-js";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { FilterBlock } from "@/lib/prospects/filter-schema";
import { filterSelectFragment } from "@/lib/prospects/filter-to-supabase";
import { SEARCH_SELECT_ALL_CAP, buildScopedQuery } from "@/lib/prospects/search-scope";
import { assertLocalOnlyEnvironment } from "@/lib/testing/local-only-guard";

assertLocalOnlyEnvironment();
const RUN = process.env.SEARCH_VOLUME === "1";
const ORG = "00000000-0000-0000-0000-000000000bbb";
const N_PROPS = 50_000;
const SAMPLES = Number(process.env.SEARCH_VOLUME_SAMPLES ?? 12);
const RESULTS = path.resolve(__dirname, "results");

let pg: PgClient;
let client: any;
let userId = "";

function mintJwt(sub: string): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub, role: "authenticated", aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 7200 });
  const sig = createHmac("sha256", process.env.FILTER_LOCAL_JWT_SECRET!).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

async function seed() {
  const { rows: existing } = await pg.query(`select count(*)::int n from public.properties where market = 'SVOL'`);
  if (existing[0].n >= N_PROPS && process.env.SEARCH_VOLUME_RESEED !== "1") {
    userId = JSON.parse(fs.readFileSync(path.join(RESULTS, "user.json"), "utf8")).userId;
    return;
  }
  userId = randomUUID();
  await pg.query("begin");
  await pg.query(`set session_replication_role = replica`);
  await pg.query(`insert into public.organizations (id, name) values ($1, 'BMH Group') on conflict do nothing`, [ORG]);
  await pg.query(`insert into auth.users (id, email, aud, role) values ($1, $2, 'authenticated', 'authenticated')`, [userId, `svol-${userId}@example.test`]);
  await pg.query(`insert into public.memberships (user_id, org_id, role) values ($1, $2, 'owner')`, [userId, ORG]);
  await pg.query(`create temp table vp as select n, gen_random_uuid() id from generate_series(0, ${N_PROPS - 1}) n`);
  await pg.query(`create temp table vc as select n, gen_random_uuid() id from generate_series(0, 59999) n`);
  // Skew: 'Smith' on ~2% of contacts, 4 more common surnames on ~1% each, 900-name long tail.
  await pg.query(`insert into public.contacts (id, org_id, first_name, last_name, email, phone_1, phone_1_type)
    select id, '${ORG}', 'First' || (n % 400),
           case when n % 50 = 0 then 'Smith' when n % 100 = 1 then 'Johnson' when n % 100 = 2 then 'Williams'
                when n % 100 = 3 then 'Brown' when n % 100 = 4 then 'Jones' else 'Surname' || (n % 900) end,
           'owner' || n || '@mail.example',
           (array['816','913','314','417','573'])[1 + n % 5] || lpad(n::text, 7, '0'), 'mobile'
      from vc`);
  // Statuses: 80% prospect, 20% across the lead stages. Properties 0..19 are the heavy lead threads.
  await pg.query(`insert into public.properties (id, org_id, address, city, state, zip, status, market, homeowner_contact_id)
    select p.id, '${ORG}', (1000 + p.n) || ' Vol St', 'Kansas City', 'MO', '6411' || (p.n % 10), 
           case when p.n < 20 then 'new_lead'
                when p.n % 5 = 1 then (array['new_lead','contacted','interested','offer_sent','dead','closed'])[1 + p.n % 6]
                else 'prospect' end,
           'SVOL', c.id from vp p join vc c on c.n = p.n % 60000`);
  // Messages: 20 heavy lead threads x 5000 + 150k spread over 25k properties. ~5% of threads contain 'roofing'.
  await pg.query(`insert into public.messages (org_id, property_id, conversation_id, channel, direction, body, read_at, created_at, from_address, to_address)
    select '${ORG}', p.id, md5(p.id::text)::uuid, 'sms', case when g % 3 = 0 then 'inbound' else 'outbound' end,
           case when g % 997 = 0 then 'about the roofing job' else 'ok sounds good' end,
           now(), now() - (g || ' minutes')::interval, '+15550000001', '+15550000002'
      from vp p cross join generate_series(1, 5000) g where p.n < 20`);
  await pg.query(`insert into public.messages (org_id, property_id, conversation_id, channel, direction, body, read_at, created_at, from_address, to_address)
    select '${ORG}', p.id, md5(p.id::text)::uuid, 'sms', case when k % 2 = 0 then 'inbound' else 'outbound' end,
           case when p.n % 20 = 0 and k % 3 = 0 then 'can you do the roofing' else 'thanks maybe later' end,
           now(), now() - (k || ' minutes')::interval, '+15550000001', '+15550000002'
      from generate_series(1, 150000) k join vp p on p.n = 20 + ((k::bigint * 7919) % 25000)`);
  await pg.query(`update public.properties set outreach_dispo = 'wrong_number' from (select id, n from vp) v where properties.id = v.id and v.n % 23 = 0`);
  await pg.query(`update public.properties set outreach_dispo = 'not_interested' from (select id, n from vp) v where properties.id = v.id and v.n % 29 = 0 and outreach_dispo is null`);
  await pg.query(`set session_replication_role = origin`);
  await pg.query("commit");
  // Seeded with triggers off: populate the message flags set-based. (Per-batch
  // refresh_property_filter_cache() needs the flag partial indexes that the fast-path
  // migration drops, so it crawls at this size; production maintains flags incrementally.)
  await pg.query("begin");
  await pg.query(`set local session_replication_role = replica`);
  await pg.query(`update public.properties p set has_inbound_message = a.hi, has_outbound_message = a.ho, has_unread_inbound = a.hu
    from (select property_id, bool_or(direction = 'inbound') hi, bool_or(direction = 'outbound') ho,
                 bool_or(direction = 'inbound' and read_at is null) hu from public.messages group by property_id) a
   where a.property_id = p.id`);
  await pg.query("commit");
  for (const t of ["properties", "contacts", "messages"]) await pg.query(`analyze public.${t}`);
  fs.mkdirSync(RESULTS, { recursive: true });
  fs.writeFileSync(path.join(RESULTS, "user.json"), JSON.stringify({ userId }));
}

const blk = (b: Record<string, unknown>): FilterBlock => ({ id: randomUUID(), ...b }) as any;
const SELECT = "id, org_id, address, city, state, zip, market, cass_status, is_vacant, created_at, status, is_dnc_locked, outreach_dispo, homeowner:contacts!properties_homeowner_contact_id_fkey(phone_1, phone_2, phone_3, do_not_contact, sms_opted_out)";

async function page(search: string | null, blocks: FilterBlock[]) {
  const frag = filterSelectFragment(blocks);
  const { builder } = await buildScopedQuery(client, {
    origin: "search_page", select: frag ? `${SELECT}, ${frag}` : SELECT, selectOpts: { count: "exact" },
    search, blockStack: blocks, includeMessages: true,
  });
  const t0 = performance.now();
  const { error, count, data } = await builder.order("created_at", { ascending: false }).order("id").range(0, 49);
  const ms = performance.now() - t0;
  return { ms, count: count as number | null, rows: data?.length ?? 0, error: error ? `${error.code ?? ""} ${error.message}`.trim() : null, code: error?.code ?? null };
}
const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(0.95 * xs.length) - 1];

async function measure(search: string | null, blocks: FilterBlock[]) {
  await page(search, blocks); // warm
  const times: number[] = [];
  let last: any = null;
  for (let i = 0; i < SAMPLES; i++) {
    last = await page(search, blocks);
    if (last.error) return { error: last.error, code: last.code };
    times.push(last.ms);
  }
  return { p95: Math.round(p95(times)), median: Math.round([...times].sort((a, b) => a - b)[Math.floor(times.length / 2)]), count: last.count };
}

beforeAll(async () => {
  if (!RUN) return;
  fs.mkdirSync(RESULTS, { recursive: true });
  pg = new PgClient({ connectionString: process.env.TEST_SUPABASE_DB_URL! });
  await pg.connect();
  const { rows: to } = await pg.query(`select rolconfig from pg_roles where rolname = 'authenticated'`);
  expect(JSON.stringify(to[0].rolconfig)).toContain("statement_timeout=8s");
  await seed();
  client = createClient(process.env.TEST_SUPABASE_URL!, process.env.TEST_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${mintJwt(userId)}` } },
  });
}, 3_600_000);

afterAll(async () => { await pg?.end(); });

const SEARCHES: Array<[string, string]> = [
  ["common surname", "Smith"],
  ["full phone", "816 0000100"],
  ["last-4 phone", "0100"],
  ["house number + street", "1500 Vol St"],
  ["word in ~5% of threads", "roofing"],
];

describe.runIf(RUN)("Search volume gate", () => {
  it("representative queries meet the page budget alone and combined with selective/broad filters", async () => {
    const selective = () => [blk({ kind: "outreach_dispo", combinator: "any", values: ["wrong_number"] })];
    const broad = () => [blk({ kind: "pipeline_status", combinator: "any", values: ["new_lead", "contacted", "interested", "offer_sent", "offer_declined", "under_contract", "closed", "dead"] })];
    const stacks: Array<[string, () => FilterBlock[]]> = [["alone", () => []], ["+ wrong_number", selective], ["+ all lead stages", broad]];
    const baselines: Record<string, any> = {};
    for (const [label, mk] of stacks) baselines[label] = await measure(null, mk());
    const rows: any[] = [];
    for (const [qname, q] of SEARCHES) {
      for (const [label, mk] of stacks) {
        const r: any = { query: qname, term: q, filters: label, search: await measure(q, mk()), noSearch: baselines[label] };
        r.ratio = r.search.p95 != null && r.noSearch.p95 ? +(r.search.p95 / r.noSearch.p95).toFixed(2) : null;
        r.within1500 = r.search.p95 != null && r.search.p95 <= 1500;
        r.within3x = r.ratio != null && r.ratio <= 3;
        rows.push(r);
        console.log(JSON.stringify(r));
      }
    }
    fs.writeFileSync(path.join(RESULTS, "latest.json"), JSON.stringify({ baselines, rows }, null, 2));
    expect(rows.filter((r) => r.search.error).map((r) => `${r.query}/${r.filters}: ${r.search.error}`)).toEqual([]);
    expect(rows.filter((r) => !r.within1500).map((r) => `${r.query}/${r.filters}`)).toEqual([]);
    // 3x the same filters without search. Below a 50 ms baseline p95 the ratio is timer/network
    // noise (3x would be under 150 ms absolute), so those cells are asserted on the absolute
    // 1.5 s budget only; every ratio is still written to latest.json.
    // A missing baseline must fail loudly, never silently skip the ratio check.
    expect(rows.filter((r) => typeof r.noSearch?.p95 !== "number").map((r) => `${r.query}/${r.filters}: no baseline`)).toEqual([]);
    expect(
      rows.filter((r) => !r.within3x && r.noSearch.p95 >= 50).map((r) => `${r.query}/${r.filters} ratio=${r.ratio}`),
    ).toEqual([]);
  }, 3_600_000);

  it("pathological inputs end in the friendly timeout or a result, never a 500", async () => {
    const out: any[] = [];
    for (const q of ["the", "816", "Vol", "St", "ok"]) {
      const r = await page(q, []);
      out.push({ q, ms: Math.round(r.ms), count: r.count, error: r.error, code: r.code });
    }
    console.log(JSON.stringify(out));
    fs.writeFileSync(path.join(RESULTS, "pathological.json"), JSON.stringify(out, null, 2));
    for (const r of out) {
      if (r.error) expect(r.code, JSON.stringify(r)).toBe("57014");
    }
  }, 600_000);

  it("select-all walk: per-page cost on a worst-case (every property matches) sets the cap", async () => {
    // Every one of the 50k properties matches "Vol St", so each 1k keyset page pays the full
    // evaluation. Time N pages; the cap is the row count walkable in <= 10 s.
    const walk = async (pages: number) => {
      let cursor: string | null = null;
      const t0 = performance.now();
      let total = 0;
      for (let i = 0; i < pages; i++) {
        const { builder } = await buildScopedQuery(client, { origin: "search_page", select: "id", search: "Vol St", blockStack: [], includeMessages: true });
        let q = builder;
        if (cursor) q = q.gt("id", cursor);
        const { data, error } = await q.order("id", { ascending: true }).limit(1000);
        if (error) return { error: `${error.code} ${error.message}`, total, ms: performance.now() - t0 };
        total += data.length;
        cursor = data.at(-1)?.id ?? null;
        if (data.length < 1000) break;
      }
      return { error: null, total, ms: performance.now() - t0 };
    };
    await walk(1);
    const results = [];
    for (const pages of [3, 10, 20]) results.push({ pages, ...(await walk(pages)) });
    console.log(JSON.stringify(results));
    fs.writeFileSync(path.join(RESULTS, "select-all.json"), JSON.stringify({ cap: SEARCH_SELECT_ALL_CAP, results }, null, 2));
    const cappedPages = SEARCH_SELECT_ALL_CAP / 1000;
    const atCap = await walk(cappedPages);
    console.log(JSON.stringify({ cap: SEARCH_SELECT_ALL_CAP, ...atCap }));
    fs.writeFileSync(path.join(RESULTS, "select-all-at-cap.json"), JSON.stringify({ cap: SEARCH_SELECT_ALL_CAP, ...atCap }, null, 2));
    expect(atCap.error).toBeNull();
    expect(atCap.ms).toBeLessThanOrEqual(10_000);
  }, 1_200_000);
});
