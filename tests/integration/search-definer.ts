import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, it } from "vitest";
import type { Database } from "@/lib/supabase/types";
import { BMH_ORG_ID, TEST_ORG_B_ID, clientForUser, createOrgUser } from "./fixtures/multi-user";

type Context = { a: SupabaseClient<Database>; b: SupabaseClient<Database>; userId: string; owner: string; live: string; conversation: string };

// Runs within the global search suite, protected by its integration advisory mutex.
export function registerDefinerTests(db: Client, service: SupabaseClient<Database>, context: () => Context) {
  async function search(q: string | null, client = context().a, per_type: number | null = 10) {
    const started = performance.now();
    const { data, error } = await client.rpc("search_global", { q: q as string, per_type: per_type as number });
    expect(error).toBeNull();
    expect(performance.now() - started).toBeLessThan(15000);
    return data ?? [];
  }
  async function definition() {
    return (await db.query("select pg_get_functiondef('public.search_global(text,integer)'::regprocedure) as body")).rows[0].body as string;
  }
  // Prove the actual behavioral assertion fails against the FINAL installed SQL,
  // restore it even on failure, then repeat that same assertion GREEN.
  async function proveMutation(name: string, mutate: (sql: string) => string, assertion: () => Promise<void>) {
    await assertion();
    if (process.env.SEARCH_D6_MUTATIONS !== "1") return;
    const original = await definition();
    const broken = mutate(original);
    expect(broken, `${name}: mutation must change installed SQL`).not.toBe(original);
    try {
      await db.query(broken);
      let failure: unknown;
      try { await assertion(); } catch (error) { failure = error; }
      expect(failure, `${name}: intended assertion must fail`).toBeInstanceOf(Error);
      expect((failure as Error).name).toBe("AssertionError");
      console.log(`D6_MUTATION ${name} RED: ${(failure as Error).message.split("\n")[0]}`);
    } finally { await db.query(original); }
    await assertion();
    console.log(`D6_MUTATION ${name} GREEN restored`);
  }
  it("D6 catalog: postgres owner, definer, restricted effective ACL and trusted schema", async () => {
    const { rows } = await db.query(`select prosecdef, pg_get_userbyid(proowner) as owner,
      has_function_privilege('anon',oid,'execute') as anon,
      has_function_privilege('authenticated',oid,'execute') as authenticated,
      has_function_privilege('service_role',oid,'execute') as service,
      has_schema_privilege('anon','public','CREATE') as anon_create,
      has_schema_privilege('authenticated','public','CREATE') as authenticated_create
      from pg_proc where oid='public.search_global(text,integer)'::regprocedure`);
    expect(rows[0]).toEqual({ prosecdef: true, owner: "postgres", anon: false, authenticated: true, service: true, anon_create: false, authenticated_create: false });
  });
  it("D6 contact authorization is outside the whole OR chain (redundant destination protection)", async () => {
    const assertion = async () => {
      expect(await definition()).toMatch(/from public\.contacts c cross join input i\s+where c\.org_id in \(select org_id from visible_orgs\) and \(\s+c\.search_text ilike[\s\S]*?or \(length\(i.qd\)[\s\S]*?\n    \)/);
    };
    await proveMutation("contact-structural", s => s.replace("where c.org_id in (select org_id from visible_orgs) and (", "where ("), assertion);
  });
  it.each([
    ["status", "access_status = 'suspended'", "m.access_status = 'active'", "true"],
    ["deletion", "deletion_prepared_at = now()", "m.deletion_prepared_at is null", "true"],
    ["expiry", "access_expires_at = now() - interval '1 day'", "(m.access_expires_at is null or m.access_expires_at > now())", "true"],
  ])("D6 membership %s revocation applies to the same previously issued JWT", async (name, update, guard, replacement) => {
    const { userId } = context();
    const queries = ["Sunflower", "Ada@example.com", "appoin"];
    for (const q of queries) expect((await search(q)).length).toBeGreaterThan(0);
    try {
      await db.query(`update public.memberships set ${update} where user_id=$1 and org_id=$2`, [userId, BMH_ORG_ID]);
      await proveMutation(`membership-${name}`, s => s.replace(guard, replacement), async () => {
        for (const q of queries) expect(await search(q)).toEqual([]);
      });
    } finally {
      await db.query("update public.memberships set access_status='active',deletion_prepared_at=null,access_expires_at=null where user_id=$1 and org_id=$2", [userId, BMH_ORG_ID]);
    }
    for (const q of queries) expect((await search(q)).length).toBeGreaterThan(0);
  });
  it.each([
    ["property-auth", "Sunflower", "property", "where p.org_id in (select org_id from visible_orgs) and p.deleted_at", "where p.deleted_at"],
    ["message-auth", "appoin", "thread", "where m.org_id in (select org_id from visible_orgs) and i.tsq", "where i.tsq"],
  ])("D6 %s independently prevents cross-org results", async (name, q, type, from, to) => {
    expect((await search(q)).filter(r => r.entity_type === type).length).toBeGreaterThan(0);
    await proveMutation(name, s => s.replace(from, to), async () => {
      expect((await search(q, context().b)).filter(r => r.entity_type === type)).toEqual([]);
    });
  });
  it("D6 combined contact and destination mutation exposes the foreign owner", async () => {
    expect((await search("Ada@example.com")).some(r => r.entity_id === context().owner)).toBe(true);
    // Contact auth alone cannot leak via either destination: both have visibility
    // AND same-org guards. Without conversation visibility it would be detectable
    // via that path alone. Keep all guards, plus the independent structural test.
    await proveMutation("contact-combined", s => s
      .replace("where c.org_id in (select org_id from visible_orgs) and (", "where (")
      .replace("p.org_id = c.org_id and p.org_id in (select org_id from visible_orgs)", "true")
      .replace("m.org_id = c.org_id and m.org_id in (select org_id from visible_orgs)", "true"), async () => {
        expect((await search("Ada@example.com", context().b)).filter(r => r.entity_type === "owner")).toEqual([]);
      });
  });
  it.each(["owner-property-same-org", "owner-conversation-same-org", "thread-title", "thread-property", "thread-property-multi-org", "thread-property-deleted"])("D6 crossed reference boundary %s", async boundary => {
    const contactA = randomUUID(), contactB = randomUUID(), propertyA = randomUUID(), propertyB = randomUUID();
    const messageA = randomUUID(), messageB = randomUUID(), convoA = randomUUID(), convoB = randomUUID();
    const multi = await createOrgUser(service, { orgId: BMH_ORG_ID, email: `d6-multi-${randomUUID()}@example.test`, role: "member" });
    const client = clientForUser(multi.jwt);
    try {
      await db.query("insert into public.memberships(user_id,org_id,role) values($1,$2,'member')", [multi.userId, TEST_ORG_B_ID]);
      await db.query("insert into public.contacts(id,org_id,first_name,phone_1_type) values($1,$2,'D6ownerneedle','unknown'),($3,$4,'Foreignsecret','unknown')", [contactA, BMH_ORG_ID, contactB, TEST_ORG_B_ID]);
      await db.query(`insert into public.properties(id,org_id,address,state,homeowner_contact_id,updated_at) values
        ($1,$2,'D6localdestination','MO',$3,'2026-09-01'),($4,$5,'D6foreigndestination','MO',$6,'2026-09-02')`, [propertyA, BMH_ORG_ID, contactA, propertyB, TEST_ORG_B_ID, contactB]);
      await db.query(`insert into public.messages(id,org_id,contact_id,property_id,conversation_id,channel,direction,body,from_address,to_address,created_at) values
        ($1,$2,$3,$4,$5,'sms','inbound','D6threadneedle','+18165550001','+18165550002','2026-09-01'),
        ($6,$7,$8,$9,$10,'sms','inbound','D6foreignthread','+18165550003','+18165550004','2026-09-02')`, [messageA, BMH_ORG_ID, contactA, propertyA, convoA, messageB, TEST_ORG_B_ID, contactB, propertyB, convoB]);
      // Positive reachability precedes corruption and every negative assertion.
      expect((await search("D6ownerneedle", client)).find(r => r.entity_id === contactA)).toMatchObject({ property_id: propertyA, conversation_id: convoA });
      expect((await search("D6foreigndestination", context().b)).some(r => r.entity_id === propertyB)).toBe(true);
      expect((await search("Foreignsecret", context().b)).some(r => r.entity_id === contactB)).toBe(true);
      expect((await search("D6threadneedle", client)).find(r => r.entity_id === messageA)).toMatchObject({ title: "D6ownerneedle", property_id: propertyA });
      expect((await search("D6foreignthread", context().b)).some(r => r.entity_id === messageB)).toBe(true);
      // Simulate legacy corruption without weakening production constraints. Local
      // replica mode affects only this test transaction and restores on commit.
      await db.query("begin");
      try {
        await db.query("set local session_replication_role = replica");
        await db.query("update public.properties set homeowner_contact_id=$1 where id=$2", [contactA, propertyB]);
        await db.query("update public.messages set contact_id=$1 where id=$2", [contactA, messageB]);
        await db.query("commit");
      } catch (error) { await db.query("rollback"); throw error; }
      if (boundary === "owner-property-same-org") await proveMutation("owner-property-same-org", s => s.replace("p.org_id = c.org_id and ", ""), async () => {
        expect((await search("D6ownerneedle", client)).find(r => r.entity_id === contactA)?.property_id).toBe(propertyA);
      });
      if (boundary === "owner-conversation-same-org") await proveMutation("owner-conversation-same-org", s => s.replace("m.org_id = c.org_id and ", ""), async () => {
        expect((await search("D6ownerneedle", client)).find(r => r.entity_id === contactA)?.conversation_id).toBe(convoA);
      });
      await db.query("begin");
      try {
        await db.query("set local session_replication_role = replica");
        await db.query("update public.messages set contact_id=$1,property_id=$2 where id=$3", [contactB, propertyB, messageA]);
        await db.query("commit");
      } catch (error) { await db.query("rollback"); throw error; }
      if (boundary === "thread-title") await proveMutation("thread-title", s => s.replace("on c.org_id = m.org_id and c.id = m.contact_id", "on c.id = m.contact_id"), async () => {
        expect((await search("D6threadneedle")).find(r => r.entity_id === messageA)?.title).toBe("+18165550001");
      });
      if (boundary === "thread-property") await proveMutation("thread-property", s => s.replace("and p.org_id = m.org_id and p.org_id in (select org_id from visible_orgs)", ""), async () => {
        for (const c of [context().a, client]) expect((await search("D6threadneedle", c)).find(r => r.entity_id === messageA)?.property_id).toBeNull();
      });
      if (boundary === "thread-property-multi-org") await proveMutation("thread-property-multi-org", s => s.replace("and p.org_id = m.org_id ", ""), async () => {
        expect((await search("D6threadneedle", client)).find(r => r.entity_id === messageA)?.property_id).toBeNull();
      });
      if (boundary !== "thread-property-deleted") return;
      await db.query("update public.messages set property_id=$1 where id=$2", [propertyA, messageA]);
      await db.query("update public.properties set deleted_at=now() where id=$1", [propertyA]);
      expect((await search("D6threadneedle", client)).find(r => r.entity_id === messageA)?.property_id).toBeNull();
    } finally {
      await db.query("delete from public.messages where id=any($1::uuid[])", [[messageA,messageB]]);
      await db.query("delete from public.properties where id=any($1::uuid[])", [[propertyA,propertyB]]);
      await db.query("delete from public.contacts where id=any($1::uuid[])", [[contactA,contactB]]);
      await service.auth.admin.deleteUser(multi.userId);
    }
  }, 120000);
  it("D6 null uid executes with zero rows for service-role and authenticated claims without sub", async () => {
    expect(await search("Sunflower", service)).toEqual([]);
    for (const role of ["service_role", "authenticated"]) {
      await db.query("begin");
      try {
        await db.query(`set local role ${role}`);
        await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role })]);
        expect((await db.query("select auth.uid() as uid")).rows[0].uid).toBeNull();
        expect((await db.query("select * from public.search_global('Sunflower',10)")).rows).toEqual([]);
      } finally { await db.query("rollback"); }
    }
  });
  it("D6 valid JWT with zero memberships returns no rows", async () => {
    const user = await createOrgUser(service, { orgId: TEST_ORG_B_ID, email: `d6-none-${randomUUID()}@example.test`, role: "member" });
    try {
      await db.query("delete from public.memberships where user_id=$1", [user.userId]);
      expect(await search("Sunflower", clientForUser(user.jwt))).toEqual([]);
    } finally { await service.auth.admin.deleteUser(user.userId); }
  });
  it("D6 anon EXECUTE is denied through PostgREST", async () => {
    const anon = createClient<Database>(process.env.TEST_SUPABASE_URL!, process.env.TEST_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
    const { error } = await anon.rpc("search_global", { q: "Sunflower" });
    expect(error?.code).toBe("42501");
  });
  it.each([null, "", "ab", "x".repeat(100), "!!!", "%_\\", "the"])("D6 direct user RPC robust for %s", async q => {
    for (const limit of [0,999,null]) {
      const rows = await search(q, context().a, limit);
      for (const type of ["property","owner","thread"]) expect(rows.filter(r => r.entity_type === type).length).toBeLessThanOrEqual(limit === 0 ? 1 : limit === null ? 5 : 10);
      if (!q || q.length < 3) expect(rows).toEqual([]);
    }
  });
}
