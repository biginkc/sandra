import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const db = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
let contactId: string;
let propertyId: string;

beforeAll(async () => {
  await db.connect();
  const metadata = () => db.query(`select proowner, prosecdef, proconfig, proacl
    from pg_proc where oid = 'public.reject_locked_property_contact_mutation()'::regprocedure`);
  const before = (await metadata()).rows;
  const sql = readFileSync(new URL("./20260909020000_dnc_guard_ignore_generated_columns.sql", import.meta.url), "utf8");
  // The integration global setup holds the shared-project mutex throughout.
  await db.query(sql);
  await db.query(sql);
  expect((await metadata()).rows).toEqual(before);
});

afterAll(async () => { await db.end(); });
beforeEach(async () => {
  await db.query("begin");
  const orgId = randomUUID();
  contactId = randomUUID();
  propertyId = randomUUID();
  await db.query("insert into public.organizations (id, name) values ($1, 'DNC generated guard fixture')", [orgId]);
  await db.query(`insert into public.contacts
    (id, org_id, contact_type, first_name, phone_1, phone_1_type, do_not_contact)
    values ($1, $2, 'person', 'Ada Guard', '+18165554991', 'mobile', false)`, [contactId, orgId]);
  await db.query(`insert into public.properties
    (id, org_id, address, state, status, homeowner_contact_id)
    values ($1, $2, 'DNC guard fixture', 'MO', 'new_lead', $3)`, [propertyId, orgId, contactId]);
});
afterEach(async () => { await db.query("rollback"); });

describe("DNC guard ignores generated columns", () => {
  it("allows a DNC-only update and retains computed values and property locking", async () => {
    const before = (await db.query("select search_text, phone_digits from public.contacts where id = $1", [contactId])).rows[0];
    expect(before.search_text).toContain("ada");
    expect(before.phone_digits).toBeTruthy();
    const { rows } = await db.query(`update public.contacts set do_not_contact = true where id = $1
      returning do_not_contact, search_text, phone_digits`, [contactId]);
    expect(rows[0]).toEqual({ ...before, do_not_contact: true });
    expect((await db.query("select is_dnc_locked from public.properties where id = $1", [propertyId])).rows[0].is_dnc_locked).toBe(true);
  });

  it.each(["first_name", "phone_1"])("rejects changing %s alongside the DNC ratchet", async (column) => {
    await db.query("savepoint rejected_update");
    await expect(db.query(`update public.contacts set do_not_contact = true, ${column} = $2 where id = $1`,
      [contactId, column === "first_name" ? "Changed" : "+18165554992"])).rejects.toMatchObject({ code: "P0001", message: "DNC_RATCHET_ONLY" });
    await db.query("rollback to savepoint rejected_update");
    expect((await db.query("select do_not_contact, first_name, phone_1 from public.contacts where id = $1", [contactId])).rows[0])
      .toEqual({ do_not_contact: false, first_name: "Ada Guard", phone_1: "+18165554991" });
  });

  it("cannot reverse the DNC ratchet", async () => {
    await db.query("update public.contacts set do_not_contact = true where id = $1", [contactId]);
    await db.query("savepoint rejected_reversal");
    await expect(db.query("update public.contacts set do_not_contact = false where id = $1", [contactId]))
      .rejects.toMatchObject({ code: "P0001", message: expect.stringMatching(/DNC/i) });
    await db.query("rollback to savepoint rejected_reversal");
    expect((await db.query("select do_not_contact from public.contacts where id = $1", [contactId])).rows[0].do_not_contact).toBe(true);
  });
});
