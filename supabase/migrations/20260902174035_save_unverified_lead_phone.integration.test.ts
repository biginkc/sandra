import { readFileSync } from "node:fs";

import { Client } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { loadTestEnv } from "@tests/integration/env";

const migrationSql = readFileSync(
  "supabase/migrations/20260902174035_save_unverified_lead_phone.sql",
  "utf8",
);

let pg: Client;
let orgId = "";
let otherOrgId = "";
let memberId = "";
let outsiderId = "";

function testDbUrl(): string {
  const env = loadTestEnv();
  const value = process.env.TEST_SUPABASE_DB_URL ?? env.TEST_SUPABASE_DB_URL;
  if (!value) throw new Error("Missing TEST_SUPABASE_DB_URL.");
  return value;
}

async function setRole(
  role: "anon" | "authenticated" | "service_role",
  userId = "",
): Promise<void> {
  await pg.query(`set local role ${role}`);
  await pg.query("select set_config('request.jwt.claim.role',$1,true)", [role]);
  await pg.query("select set_config('request.jwt.claim.sub',$1,true)", [
    userId,
  ]);
}

async function expectDbError(
  operation: () => Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  await pg.query("savepoint expected_error");
  let caught: unknown;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }
  await pg.query("rollback to savepoint expected_error");
  await pg.query("release savepoint expected_error");
  expect(caught).toMatchObject({ message: expect.stringMatching(pattern) });
}

async function callRpc(input: {
  phone: string;
  contactId?: string | null;
  targetOrgId?: string;
}): Promise<{ contact_id: string; outcome: string; phone_slot: number | null }> {
  const result = await pg.query<{
    contact_id: string;
    outcome: string;
    phone_slot: number | null;
  }>(
    `select * from public.save_unverified_lead_phone(
       $1::uuid,$2::text,$3::uuid,$4::text,$5::text,$6::text
     )`,
    [
      input.targetOrgId ?? orgId,
      input.phone,
      input.contactId ?? null,
      "Test",
      "Lead",
      null,
    ],
  );
  return result.rows[0];
}

describe("save_unverified_lead_phone migration", () => {
  beforeAll(async () => {
    pg = new Client({ connectionString: testDbUrl() });
    await pg.connect();
    await pg.query(migrationSql);
    await pg.query(migrationSql);
  });

  afterAll(async () => {
    await pg.end();
  });

  beforeEach(async () => {
    await pg.query("begin");
    orgId = crypto.randomUUID();
    otherOrgId = crypto.randomUUID();
    memberId = crypto.randomUUID();
    outsiderId = crypto.randomUUID();

    await pg.query("insert into auth.users(id) values ($1),($2)", [
      memberId,
      outsiderId,
    ]);
    await pg.query(
      "insert into public.organizations(id,name) values ($1,'Phone RPC A'),($2,'Phone RPC B')",
      [orgId, otherOrgId],
    );
    await pg.query(
      `insert into public.memberships(user_id,org_id,role)
       values ($1,$2,'owner'),($3,$4,'owner')`,
      [memberId, orgId, outsiderId, otherOrgId],
    );
  });

  afterEach(async () => {
    await pg.query("rollback");
    await pg.query("reset role");
  });

  it("keeps normal authenticated writes from saving unknown phone types", async () => {
    await setRole("authenticated", memberId);

    await expectDbError(
      () =>
        pg.query(
          `insert into public.contacts(org_id,first_name,phone_1,phone_1_type)
           values ($1,'Raw',$2,'unknown')`,
          [orgId, "+18162000001"],
        ),
      /phone_1 requires a line type/i,
    );
  });

  it("inserts a new unverified lead phone through the narrow RPC", async () => {
    await setRole("authenticated", memberId);

    await expect(callRpc({ phone: "+18162000002" })).resolves.toEqual({
      contact_id: expect.any(String),
      outcome: "inserted",
      phone_slot: 1,
    });

    const saved = await pg.query(
      `select phone_1, phone_1_type
       from public.contacts
       where org_id = $1 and phone_1 = $2`,
      [orgId, "+18162000002"],
    );
    expect(saved.rows[0]).toEqual({
      phone_1: "+18162000002",
      phone_1_type: "unknown",
    });
  });

  it("appends one unverified phone without replacing an existing phone", async () => {
    const contactId = crypto.randomUUID();
    await pg.query(
      `insert into public.contacts(
         id,org_id,first_name,phone_1,phone_1_type
       ) values ($1,$2,'Existing',$3,'mobile')`,
      [contactId, orgId, "+18162000003"],
    );
    await setRole("authenticated", memberId);

    await expect(
      callRpc({ contactId, phone: "+18162000004" }),
    ).resolves.toEqual({
      contact_id: contactId,
      outcome: "appended",
      phone_slot: 2,
    });

    const saved = await pg.query(
      `select phone_1, phone_1_type, phone_2, phone_2_type
       from public.contacts where id = $1`,
      [contactId],
    );
    expect(saved.rows[0]).toEqual({
      phone_1: "+18162000003",
      phone_1_type: "mobile",
      phone_2: "+18162000004",
      phone_2_type: "unknown",
    });
  });

  it("returns the existing slot when the same append is retried", async () => {
    const contactId = crypto.randomUUID();
    await pg.query(
      `insert into public.contacts(
         id,org_id,first_name,phone_1,phone_1_type
       ) values ($1,$2,'Retry',$3,'mobile')`,
      [contactId, orgId, "+18162000013"],
    );
    await setRole("authenticated", memberId);

    await callRpc({ contactId, phone: "+18162000014" });
    await expect(
      callRpc({ contactId, phone: "+18162000014" }),
    ).resolves.toEqual({
      contact_id: contactId,
      outcome: "already_present",
      phone_slot: 2,
    });

    const saved = await pg.query(
      `select phone_1, phone_2, phone_3
       from public.contacts where id = $1`,
      [contactId],
    );
    expect(saved.rows[0]).toEqual({
      phone_1: "+18162000013",
      phone_2: "+18162000014",
      phone_3: null,
    });
  });

  it("does not replace a phone when all three slots are full", async () => {
    const contactId = crypto.randomUUID();
    await pg.query(
      `insert into public.contacts(
         id,org_id,first_name,
         phone_1,phone_1_type,phone_2,phone_2_type,phone_3,phone_3_type
       ) values ($1,$2,'Full',$3,'mobile',$4,'landline',$5,'mobile')`,
      [
        contactId,
        orgId,
        "+18162000015",
        "+18162000016",
        "+18162000017",
      ],
    );
    await setRole("authenticated", memberId);

    await expect(
      callRpc({ contactId, phone: "+18162000018" }),
    ).resolves.toEqual({
      contact_id: contactId,
      outcome: "no_open_phone_slot",
      phone_slot: null,
    });

    const saved = await pg.query(
      `select phone_1, phone_2, phone_3
       from public.contacts where id = $1`,
      [contactId],
    );
    expect(saved.rows[0]).toEqual({
      phone_1: "+18162000015",
      phone_2: "+18162000016",
      phone_3: "+18162000017",
    });
  });

  it("keeps tenant RLS in force for RPC inserts and appends", async () => {
    const otherContactId = crypto.randomUUID();
    await pg.query(
      `insert into public.contacts(
         id,org_id,first_name,phone_1,phone_1_type
       ) values ($1,$2,'Other',$3,'mobile')`,
      [otherContactId, otherOrgId, "+18162000005"],
    );
    await setRole("authenticated", memberId);

    await expectDbError(
      () =>
        callRpc({
          targetOrgId: otherOrgId,
          phone: "+18162000006",
        }),
      /row-level security policy/i,
    );
    await expectDbError(
      () =>
        callRpc({
          targetOrgId: otherOrgId,
          contactId: otherContactId,
          phone: "+18162000007",
        }),
      /CONTACT_NOT_FOUND/i,
    );
  });

  it("still runs the permanent DNC triggers when the RPC appends a phone", async () => {
    const contactId = crypto.randomUUID();
    const propertyId = crypto.randomUUID();
    const dncPhone = "+18162000008";
    await pg.query(
      `insert into public.contacts(
         id,org_id,first_name,phone_1,phone_1_type
       ) values ($1,$2,'DNC target',$3,'mobile')`,
      [contactId, orgId, "+18162000009"],
    );
    await pg.query(
      `insert into public.properties(
         id,org_id,address,state,homeowner_contact_id
       ) values ($1,$2,'1 Test St','MO',$3)`,
      [propertyId, orgId, contactId],
    );
    await pg.query(
      `insert into public.global_phone_dnc_registry(
         org_id,phone_e164,first_consumer_id,first_source_event_id,
         first_evidence_sha256
       ) values ($1,$2,$3,'phone-rpc-test',repeat('a',64))`,
      [orgId, dncPhone, crypto.randomUUID()],
    );
    await setRole("authenticated", memberId);

    await expect(callRpc({ contactId, phone: dncPhone })).resolves.toEqual({
      contact_id: contactId,
      outcome: "appended",
      phone_slot: 2,
    });

    const safety = await pg.query(
      `select contact.do_not_contact, property.is_dnc_locked
       from public.contacts contact
       join public.properties property
         on property.homeowner_contact_id = contact.id
       where contact.id = $1 and property.id = $2`,
      [contactId, propertyId],
    );
    expect(safety.rows[0]).toEqual({
      do_not_contact: true,
      is_dnc_locked: true,
    });
  });

  it("refuses to append to a contact that is already DNC locked", async () => {
    const contactId = crypto.randomUUID();
    await pg.query(
      `insert into public.contacts(
         id,org_id,first_name,phone_1,phone_1_type,do_not_contact
       ) values ($1,$2,'Locked',$3,'mobile',true)`,
      [contactId, orgId, "+18162000010"],
    );
    await setRole("authenticated", memberId);

    await expectDbError(
      () => callRpc({ contactId, phone: "+18162000011" }),
      /DNC_LOCKED/i,
    );
  });

  it("does not expose the RPC to anonymous callers", async () => {
    await setRole("anon");

    await expectDbError(
      () => callRpc({ phone: "+18162000012" }),
      /permission denied for function save_unverified_lead_phone/i,
    );
  });
});
