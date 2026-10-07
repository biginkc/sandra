// Forward-recovery proof for the Norma queue cutover (plan [G1]). Loopback-only, needs three disposable
// databases cloned from the same pre-queue chain (see NORMA_ROLLBACK_* below), so it is skipped unless all are set:
//   BASELINE: chain through 20261008135100 (no 150000, no 150100)  - the reference catalog
//   MID:      BASELINE + 20261008150000 (legacy claim disabled)    - 150100 "cannot land"
//   FULL:     BASELINE + 150000 + 150100 (queue installed)
// Every test runs in a transaction that is rolled back; BASELINE is only read.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { describe, expect, it } from "vitest";

import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";
import { svc } from "@tests/integration/norma-next-step-support";

const env = (k: string) => (process.env[k] ? requireLoopbackPostgresUrl(process.env[k]!) : null);
const BASELINE = env("NORMA_ROLLBACK_BASELINE_DB_URL");
const MID = env("NORMA_ROLLBACK_MID_DB_URL");
const FULL = env("NORMA_ROLLBACK_FULL_DB_URL");
const ready = Boolean(BASELINE && MID && FULL);

const sql = (file: string) =>
  readFileSync(path.join(process.cwd(), "supabase", file), "utf8").replace(/^\s*begin;\s*$/gim, "").replace(/^\s*commit;\s*$/gim, "");
const RECOVERY = sql("rollbacks/20261008150000_norma_legacy_claim_disable.sql");
const QUEUE_ROLLBACK = sql("rollbacks/20261008150100_norma_call_queue.sql");

// Whole public + norma_private catalog: function bodies, owners and ACLs; relations, ACLs, columns, indexes,
// constraints, triggers, policies and schema ACLs.
const SNAPSHOT = [
  `select 'FUNC '||p.oid::regprocedure||' owner='||pg_get_userbyid(p.proowner)||' acl='||coalesce(p.proacl::text,'NULL')||E'\\n'||pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','norma_private') and p.prokind in ('f','p')`,
  `select 'REL '||n.nspname||'.'||c.relname||' kind='||c.relkind::text||' owner='||pg_get_userbyid(c.relowner)||' rls='||c.relrowsecurity||' acl='||coalesce(c.relacl::text,'NULL') from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','norma_private') and c.relkind in ('r','v','m','S','p')`,
  `select 'COL '||c.relname||'.'||a.attname||' '||format_type(a.atttypid,a.atttypmod)||' nn='||a.attnotnull||' def='||coalesce(pg_get_expr(d.adbin,d.adrelid),'')||' acl='||coalesce(a.attacl::text,'') from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where n.nspname in ('public','norma_private') and c.relkind in ('r','p') and a.attnum>0 and not a.attisdropped`,
  `select 'IDX '||indexdef from pg_indexes where schemaname in ('public','norma_private')`,
  `select 'CON '||conrelid::regclass||' '||conname||' '||pg_get_constraintdef(oid) from pg_constraint where connamespace in ('public'::regnamespace,'norma_private'::regnamespace)`,
  `select 'TRG '||pg_get_triggerdef(t.oid)||' enabled='||t.tgenabled::text from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where not t.tgisinternal and n.nspname in ('public','norma_private','auth')`,
  `select 'POL '||schemaname||'.'||tablename||' '||policyname||' '||cmd||' roles='||roles::text||' q='||coalesce(qual,'')||' wc='||coalesce(with_check,'') from pg_policies where schemaname in ('public','norma_private')`,
  `select 'SCHEMA '||nspname||' owner='||pg_get_userbyid(nspowner)||' acl='||coalesce(nspacl::text,'NULL') from pg_namespace where nspname in ('public','norma_private')`,
];
async function snapshot(db: Client): Promise<string[]> {
  const rows: string[] = [];
  for (const q of SNAPSHOT) rows.push(...(await db.query({ text: q, rowMode: "array" })).rows.map((r: unknown[]) => String(r[0])));
  return rows.sort();
}
const diff = (a: string[], b: string[]) => {
  const sa = new Set(a), sb = new Set(b);
  return { onlyReference: a.filter((x) => !sb.has(x)), onlyActual: b.filter((x) => !sa.has(x)) };
};
async function inTx<T>(url: string, fn: (db: Client) => Promise<T>): Promise<T> {
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query("begin");
    return await fn(db);
  } finally {
    await db.query("rollback").catch(() => {});
    await db.end();
  }
}
const baselineSnapshot = async () => {
  const db = new Client({ connectionString: BASELINE! });
  await db.connect();
  try { return await snapshot(db); } finally { await db.end(); }
};
const claimLine = (s: string[]) => s.filter((x) => x.startsWith("FUNC fn_norma_claim_dispatch(") || x.startsWith("FUNC public.fn_norma_claim_dispatch("));

describe.skipIf(!ready)("Norma queue forward recovery (loopback disposable DBs)", () => {
  it("MID: the disabled claim returns false, recovery restores the exact pre-queue claim and catalog", async () => {
    const reference = await baselineSnapshot();
    const before = await inTx(MID!, snapshot);
    expect(diff(reference, before).onlyReference.join("\n")).toContain("fn_norma_claim_dispatch");
    const after = await inTx(MID!, async (db) => {
      await db.query(RECOVERY);
      return snapshot(db);
    });
    expect(diff(reference, after)).toEqual({ onlyReference: [], onlyActual: [] });
    expect(claimLine(after)).toEqual(claimLine(reference));
  });

  it("MID: legacy claim behaviour - false before recovery, claims once and fences stale attempts after", async () => {
    await inTx(MID!, async (db) => {
      const org = randomUUID(), rep = randomUUID(), assignee = randomUUID(), sequence = randomUUID(), contact = randomUUID(), property = randomUUID();
      await db.query("insert into auth.users(id) values ($1), ($2)", [rep, assignee]);
      await db.query("insert into public.organizations(id,name) values ($1,'norma recovery')", [org]);
      await db.query("insert into public.memberships(user_id,org_id,role,access_status) values ($1,$2,'owner','active'), ($3,$2,'member','active')", [assignee, org, rep]);
      await db.query("insert into public.acquisition_org_settings(org_id,my_leads_enabled) values ($1,true)", [org]);
      await db.query("insert into public.sequences(id,org_id,name) values ($1,$2,'Norma drip')", [sequence, org]);
      await db.query("insert into public.sequence_steps(sequence_id,step_index,action_type,template_body) values ($1,0,'send_sms','hi')", [sequence]);
      await db.query("insert into public.contacts(id,org_id,first_name,phone_1,phone_1_type) values ($1,$2,'Seller','+18165571234','mobile')", [contact, org]);
      await db.query("insert into public.properties(id,org_id,address,state,status,homeowner_contact_id) values ($1,$2,'1 Recovery St','MO','new_lead',$3)", [property, org, contact]);
      await db.query("insert into public.sequence_enrollments(org_id,sequence_id,property_id,contact_id,status,next_run_at) values ($1,$2,$3,$4,'active',now())", [org, sequence, property, contact]);
      const created = await svc<{ request_id: string | null }>(db, "select * from public.fn_norma_create_request($1,$2,$3,$4,$5,$6)", [property, contact, "+18165571234", rep, "ctx", assignee]);
      const id = created.rows[0]!.request_id!;
      expect(id).toBeTruthy();
      const claim = async (attempt: number | null = null) =>
        (await svc<{ c: boolean }>(db, "select public.fn_norma_claim_dispatch($1,$2) as c", [id, attempt])).rows[0]!.c;
      const status = async () => (await db.query("select status from public.norma_call_requests where id=$1", [id])).rows[0];
      expect(await claim()).toBe(false);
      expect(await status()).toEqual({ status: "requested" });
      await db.query(RECOVERY);
      expect(await claim(2)).toBe(false); // wrong attempt fence
      expect(await claim()).toBe(true);
      expect(await status()).toEqual({ status: "dispatching" });
      expect(await claim()).toBe(false); // already claimed
      expect((await db.query("select has_function_privilege('anon','public.fn_norma_claim_dispatch(uuid,integer)','execute') a, has_function_privilege('authenticated','public.fn_norma_claim_dispatch(uuid,integer)','execute') u")).rows[0]).toEqual({ a: false, u: false });
    });
  });

  it("MID: recovery refuses while queue objects exist", async () => {
    await inTx(MID!, async (db) => {
      await db.query("create table public.norma_queue_entries(id uuid)");
      await expect(db.query(RECOVERY)).rejects.toMatchObject({ code: "55000" });
    });
  });

  it("FULL: the 150100 rollback drops the queue and restores every touched catalog entry; recovery then matches baseline exactly", async () => {
    const reference = await baselineSnapshot();
    const installed = await inTx(FULL!, snapshot);
    expect(installed.some((x) => x.includes("norma_queue_entries"))).toBe(true);
    await inTx(FULL!, async (db) => {
      await db.query(QUEUE_ROLLBACK);
      const rolled = await snapshot(db);
      expect(rolled.filter((x) => /norma_queue|norma_followup_reassignments|norma_state_timezones|fn_norma_queue_|_v2\(|fn_norma_mark_sending|queue_entry_id|queue_lease_token|queue_dispatch_token|send_attempted_at|zz_norma_queue/.test(x))).toEqual([]);
      // Only the intentionally disabled claim may still differ at this point.
      const d = diff(reference, rolled);
      expect([...d.onlyReference, ...d.onlyActual].every((x) => x.includes("fn_norma_claim_dispatch"))).toBe(true);
      expect(d.onlyActual.length).toBeGreaterThan(0);
      await db.query(RECOVERY);
      expect(diff(reference, await snapshot(db))).toEqual({ onlyReference: [], onlyActual: [] });
    });
  });

  it("FULL: the 150100 rollback refuses while the queue is enabled", async () => {
    await inTx(FULL!, async (db) => {
      await db.query("insert into public.norma_queue_control(singleton, enabled) values (true, true) on conflict (singleton) do update set enabled = true");
      await expect(db.query(QUEUE_ROLLBACK)).rejects.toMatchObject({ code: "55000" });
    });
  });
});
