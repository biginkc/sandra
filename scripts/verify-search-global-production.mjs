// Read-only post-deploy acceptance. Supply an existing authorized user JWT.
// Does not apply migrations, create users, or write production data.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import pg from "pg";

const required = ["SEARCH_PROD_DATABASE_URL", "SEARCH_PROD_URL", "SEARCH_PROD_ANON_KEY", "SEARCH_PROD_JWT"];
for (const name of required) assert(process.env[name], `Missing ${name}`);
const claims = JSON.parse(Buffer.from(process.env.SEARCH_PROD_JWT.split(".")[1], "base64url").toString());
assert(claims.sub && claims.role === "authenticated", "Use an existing authenticated user JWT with sub");
const url = new URL(process.env.SEARCH_PROD_URL);
assert(process.env.SEARCH_PROD_DATABASE_URL.includes(url.hostname.split(".")[0]), "DB and RPC must target the same project");
assert(url.protocol === "https:", "PostgREST must use HTTPS");
assert(!url.hostname.startsWith("ncsngxlcyxylaeskiteu."), "This command is production acceptance, not the integration project");
const db = new pg.Client({ connectionString: process.env.SEARCH_PROD_DATABASE_URL });

// Independent D1/D4 baseline, evaluated under authenticated RLS. Only the
// intentional crossed-reference security corrections are added to the oracle.
const source = readFileSync(new URL("../supabase/migrations/20260909080600_search_relevance_fixes.sql", import.meta.url), "utf8");
const start = source.indexOf("as $$", source.indexOf("create or replace function public.search_global")) + "as $$".length;
let oracle = source.slice(start, source.indexOf("$$;", start));
for (const [from, to] of [
  ["where (p.homeowner_contact_id", "where p.org_id = c.org_id and (p.homeowner_contact_id"],
  ["where m.contact_id = c.id", "where m.org_id = c.org_id and m.contact_id = c.id"],
  ["m.id as entity_id, m.property_id,", "m.id as entity_id, (select p.id from public.properties p where p.id=m.property_id and p.org_id=m.org_id and p.deleted_at is null) as property_id,"],
  ["on c.id = m.contact_id", "on c.org_id = m.org_id and c.id = m.contact_id"],
]) {
  assert(oracle.includes(from), `Baseline correction missing: ${from}`);
  oracle = oracle.replace(from, to);
}
const queries = ["Jordan", "8111 N Stoddard", "8165551234", "Bhaggard90@gmail.com", "appoin"];
const canonical = rows => rows.map(row => JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))))).sort();
await db.connect();
try {
  const installed = (await db.query("select pg_get_functiondef(oid) as definition, prosecdef from pg_proc where oid='public.search_global(text,integer)'::regprocedure")).rows[0];
  assert(installed.prosecdef, "D6 has not deployed; refusing to count baseline timings as D6 acceptance");
  const measurements = [];
  for (const q of queries) {
    // The oracle and all request claims share one explicit read-only transaction.
    await db.query("begin read only");
    let expected;
    try {
      await db.query("set local role authenticated");
      await db.query("set local search_path=public,pg_temp");
      await db.query("set local statement_timeout='30s'");
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify(claims)]);
      assert.equal((await db.query("select auth.uid() as uid")).rows[0].uid, claims.sub);
      assert((await db.query("select count(*)::int as n from public.memberships where user_id=auth.uid() and access_status='active' and deletion_prepared_at is null and (access_expires_at is null or access_expires_at>now())")).rows[0].n>0, "JWT must have active visible membership");
      expected = (await db.query(oracle, [q, 5])).rows;
    } finally { await db.query("rollback"); }
    const times = [];
    for (let i=0; i<23; i++) {
      assert.equal((await db.query("select pg_get_functiondef('public.search_global(text,integer)'::regprocedure) as definition")).rows[0].definition, installed.definition, "Definition changed during acceptance");
      const start = performance.now();
      const response = await fetch(new URL("/rest/v1/rpc/search_global", url), {
        method: "POST",
        headers: { apikey: process.env.SEARCH_PROD_ANON_KEY, Authorization: `Bearer ${process.env.SEARCH_PROD_JWT}`, "Content-Type": "application/json" },
        body: JSON.stringify({ q, per_type: 5 }),
        signal: AbortSignal.timeout(30000),
      });
      assert(response.ok, `RPC HTTP ${response.status}`);
      const rows = await response.json();
      const elapsed = performance.now()-start;
      assert.deepEqual(canonical(rows), canonical(expected), `${q}: row set differs from corrected D1/D4 oracle`);
      if(i>=3) times.push(elapsed);
    }
    times.sort((a,b)=>a-b);
    const result={q,warmups:3,samples:20,p95Ms:times[18],maxMs:times[19],rowCount:expected.length};
    measurements.push(result);
    console.log(JSON.stringify(result));
  }
  for(const result of measurements) assert(result.p95Ms<500, `${result.q}: p95 ${result.p95Ms}ms exceeds 500ms`);
} finally { await db.end(); }
