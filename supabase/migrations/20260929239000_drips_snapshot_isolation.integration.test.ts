import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { expect, it } from "vitest";
import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";

const url = requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres");
const sql = readFileSync(new URL("./20260929239000_drips_followups.sql", import.meta.url), "utf8");
type Snapshot = { rows: Array<{ thread_id: string }>; total: number; counts: Record<string, number> };

type Fixture = { db: Client; actor: string; orgA: string; orgB: string; threadA: string; threadB: string; marker: string };
async function fixture(): Promise<Fixture> {
  const db = new Client({ connectionString: url });
  await db.connect();
  await db.query("begin");
  const actor = randomUUID(), orgA = randomUUID(), orgB = randomUUID();
  const marker = `isolation${randomUUID().replaceAll("-", "")}`;
  const threadA = randomUUID(), threadB = randomUUID();
  await db.query("insert into auth.users(id) values ($1)", [actor]);
  for (const [org, thread] of [[orgA, threadA], [orgB, threadB]]) {
    const contact = randomUUID(), property = randomUUID();
    await db.query("insert into public.organizations(id,name) values ($1,$2)", [org, `${marker}-${org}`]);
    await db.query("insert into public.contacts(id,org_id,first_name) values ($1,$2,$3)", [contact, org, marker]);
    await db.query("insert into public.properties(id,org_id,address,state,status,homeowner_contact_id) values ($1,$2,'Isolation Lane','MO','new_lead',$3)", [property, org, contact]);
    await db.query("insert into public.messages(org_id,contact_id,property_id,conversation_id,channel,direction,status,body,from_address,to_address) values ($1,$2,$3,$4,'sms','inbound','received',$5,'+18165550100','+18165550200')", [org, contact, property, thread, marker]);
  }
  const anchorOwner = randomUUID();
  await db.query("insert into auth.users(id) values ($1)", [anchorOwner]);
  await db.query("insert into public.memberships(user_id,org_id,role,access_status) values ($1,$2,'owner','active')", [anchorOwner, orgA]);
  await db.query(sql);
  return { db, actor, orgA, orgB, threadA, threadB, marker };
}
async function asAuthenticated(f: Fixture, role = "authenticated") {
  await f.db.query("set local role authenticated");
  await f.db.query("select set_config('request.jwt.claim.role',$1,true)", [role]);
  await f.db.query("select set_config('request.jwt.claim.sub',$1,true)", [f.actor]);
}
async function snapshot(f: Fixture): Promise<Snapshot> {
  return (await f.db.query<{snapshot: Snapshot}>(
    "select public.sms_inbox_thread_page_snapshot(now()-interval '90 days','all',null,null,false,500,0,$1) as snapshot", [f.marker],
  )).rows[0]!.snapshot;
}
function expectEmpty(result: Snapshot) {
  expect(result.rows).toEqual([]);
  expect(result.total).toBe(0);
  expect(Object.values(result.counts).every(count => count === 0)).toBe(true);
}
async function rollback(f: Fixture | undefined) {
  if (!f) return;
  await f.db.query("rollback").catch(() => {});
  await f.db.end();
}

it("never returns org B's thread to an org A member", async () => {
  let f: Fixture | undefined;
  try {
    f = await fixture();
    await f.db.query("insert into public.memberships(user_id,org_id,role,access_status) values ($1,$2,'owner','active')", [f.actor, f.orgA]);
    await asAuthenticated(f);
    const result = await snapshot(f);
    expect(result.rows.map(row => row.thread_id)).toEqual([f.threadA]);
    const threadB = f.threadB;
    expect(result.rows.some(row => row.thread_id === threadB)).toBe(false);
  } finally { await rollback(f); }
}, 60_000);

it("returns zero rows and counts to a non-member", async () => {
  let f: Fixture | undefined;
  try { f = await fixture(); await asAuthenticated(f); expectEmpty(await snapshot(f)); }
  finally { await rollback(f); }
}, 60_000);

it("returns zero rows and counts to an expired member", async () => {
  let f: Fixture | undefined;
  try {
    f = await fixture();
    await f.db.query("insert into public.memberships(user_id,org_id,role,access_status,access_expires_at) values ($1,$2,'member','active',now()-interval '1 day')", [f.actor, f.orgA]);
    await asAuthenticated(f);
    expectEmpty(await snapshot(f));
  } finally { await rollback(f); }
}, 60_000);

it("returns zero rows and counts to a deletion-prepared member", async () => {
  let f: Fixture | undefined;
  try {
    f = await fixture();
    await f.db.query("insert into public.memberships(user_id,org_id,role,access_status,deletion_prepared_at) values ($1,$2,'member','active',now())", [f.actor, f.orgA]);
    await asAuthenticated(f);
    expectEmpty(await snapshot(f));
  } finally { await rollback(f); }
}, 60_000);

it("denies anon execution", async () => {
  let f: Fixture | undefined;
  try {
    f = await fixture();
    await f.db.query("set local role anon");
    await f.db.query("select set_config('request.jwt.claim.role','anon',true)");
    await expect(snapshot(f)).rejects.toMatchObject({ code: "42501" });
  } finally { await rollback(f); }
}, 60_000);

it("does not let an authenticated non-service JWT reach the service-role branch", async () => {
  let f: Fixture | undefined;
  try {
    f = await fixture();
    await asAuthenticated(f, "authenticated");
    expectEmpty(await snapshot(f));
  } finally { await rollback(f); }
}, 60_000);
