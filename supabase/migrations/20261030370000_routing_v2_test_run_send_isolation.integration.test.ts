import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";

const db = new Client({ connectionString: requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL!) });
const sql = (name: string, dir = __dirname) => readFileSync(path.join(dir, name), "utf8").replace(/^\s*(begin|commit);\s*$/gim, "");
const M = "20261030370000_routing_v2_test_run_send_isolation.sql";
let org: string, property: string, inbound: string;

beforeAll(() => db.connect());
afterAll(() => db.end());
beforeEach(async () => {
  await db.query("begin");
  await db.query(sql(M));
  org = randomUUID();
  await db.query("insert into organizations(id,name) values($1,'isolation test')", [org]);
  const contact = (await db.query("insert into contacts(org_id,first_name,phone_1,phone_1_type) values($1,'T','+18165550100','mobile') returning id", [org])).rows[0].id;
  property = (await db.query("insert into properties(org_id,address,state,status,homeowner_contact_id) values($1,'1 Test St','MO','new_lead',$2) returning id", [org, contact])).rows[0].id;
  inbound = (await db.query("insert into messages(org_id,property_id,contact_id,direction,channel,body) values($1,$2,$3,'inbound','sms','Who?') returning id", [org, property, contact])).rows[0].id;
});
afterEach(() => db.query("rollback"));

const outbox = async () => (await db.query("insert into routing_v2_outbox(org_id,property_id,inbound_message_id,transition_seq,kind,slice) values($1,$2,$3,1,'reply','replies') returning test_run_id", [org, property, inbound])).rows[0].test_run_id;

describe("§5.4 test-run taint", () => {
  it("an outbox row derived from a test-tagged lead inherits the tag; a real lead stays untagged", async () => {
    expect(await outbox()).toBeNull();
    await db.query("update properties set test_run_id='run-7' where id=$1", [property]);
    expect(await outbox()).toBe("run-7");
  });
  it("refusal rows keep at most the last 4 digits; service role only", async () => {
    await db.query("insert into test_send_refusals(org_id,property_id,test_run_id,destination_last4,origin,reason) values($1,$2,'run-7','0191','automated','refused_non_owned')", [org, property]);
    await db.query("savepoint s");
    await expect(db.query("insert into test_send_refusals(org_id,destination_last4,origin,reason) values($1,'8165550191','automated','refused_non_owned')", [org])).rejects.toMatchObject({ code: "23514" });
    await db.query("rollback to savepoint s");
    expect((await db.query("select has_table_privilege('authenticated','public.test_send_refusals','SELECT') u, has_table_privilege('service_role','public.test_send_refusals','INSERT') s")).rows[0]).toEqual({ u: false, s: true });
  });
  it("is idempotent; rollback refuses while a lead is tagged, then removes everything", async () => {
    await db.query(sql(M));
    await db.query("update properties set test_run_id='run-7' where id=$1", [property]);
    await db.query("savepoint s");
    await expect(db.query(sql("20261030370000_routing_v2_test_run_send_isolation.sql", path.join(__dirname, "../rollbacks")))).rejects.toThrow(/test-tagged leads exist/);
    await db.query("rollback to savepoint s");
    await db.query("update properties set test_run_id=null where id=$1", [property]);
    await db.query(sql("20261030370000_routing_v2_test_run_send_isolation.sql", path.join(__dirname, "../rollbacks")));
    expect((await db.query("select to_regclass('public.test_send_refusals') t")).rows[0].t).toBeNull();
  });
});
