import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadTestEnv } from "@tests/integration/env";

const migrationSql = readFileSync(
  "supabase/migrations/20260830092331_switchboard_contact_preferences.sql",
  "utf8",
)
  .replace(/\nbegin;\s*/i, "\n")
  .replace(/\s*commit;\s*$/i, "");

let pg: Client;
let transactionOpen = false;

function testDbUrl(): string {
  const env = loadTestEnv();
  const url = process.env.TEST_SUPABASE_DB_URL ?? env.TEST_SUPABASE_DB_URL;
  if (!url) {
    throw new Error("Missing TEST_SUPABASE_DB_URL for Switchboard migration tests.");
  }
  if (url.includes("copflsklaefwzipsrjqz")) {
    throw new Error("Refusing to run Switchboard migration tests against production.");
  }
  return url;
}

async function setServiceRole(client = pg): Promise<void> {
  await client.query(
    "select set_config('request.jwt.claim.role', 'service_role', true)",
  );
  await client.query(
    "select set_config('request.jwt.claim.sub', '', true)",
  );
}

type Fixture = {
  orgId: string;
  consumerId: string;
  contactIds: string[];
  propertyIds: string[];
  enrollmentIds: string[];
  phone: string;
};

async function seedFixture(
  client = pg,
  options: { contacts?: number; propertiesPerContact?: number } = {},
): Promise<Fixture> {
  const orgId = crypto.randomUUID();
  const consumerId = crypto.randomUUID();
  const phone = `+1816${String(Math.floor(Math.random() * 1_000_0000)).padStart(7, "0")}`;
  const contactIds: string[] = [];
  const propertyIds: string[] = [];
  const enrollmentIds: string[] = [];

  await client.query(
    "insert into public.organizations (id, name) values ($1, $2)",
    [orgId, `Switchboard isolated ${orgId}`],
  );
  await client.query(
    `insert into public.webhook_consumers (
       id, org_id, name, secret_hash, consumer_type, default_source
     ) values ($1, $2, $3, $4, 'switchboard_contact_preference', null)`,
    [
      consumerId,
      orgId,
      `Switchboard ${consumerId}`,
      consumerId.replaceAll("-", "").padEnd(64, "0"),
    ],
  );

  for (let contactIndex = 0; contactIndex < (options.contacts ?? 1); contactIndex += 1) {
    const contactId = crypto.randomUUID();
    contactIds.push(contactId);
    if (contactIndex === 0) {
      await client.query(
        `insert into public.contacts (
           id, org_id, first_name, last_name, phone_1, phone_1_type
         ) values ($1, $2, 'Synthetic', 'Switchboard', $3, 'mobile')`,
        [contactId, orgId, phone],
      );
    } else {
      await client.query(
        `insert into public.contacts (
           id, org_id, first_name, last_name, phone_2, phone_2_type
         ) values ($1, $2, 'Synthetic', 'Switchboard', $3, 'mobile')`,
        [contactId, orgId, phone],
      );
    }

    for (
      let propertyIndex = 0;
      propertyIndex < (options.propertiesPerContact ?? 1);
      propertyIndex += 1
    ) {
      const propertyId = crypto.randomUUID();
      const sequenceId = crypto.randomUUID();
      const enrollmentId = crypto.randomUUID();
      const addressNormalized = `${100 + contactIndex * 10 + propertyIndex} test st`;
      propertyIds.push(propertyId);
      enrollmentIds.push(enrollmentId);
      await client.query(
        `insert into public.properties (
           id, org_id, address, address_normalized, city, state, zip,
           status, homeowner_contact_id
         ) values ($1, $2, $3, $3, 'Kansas City', 'MO', '64108',
           'new_lead', $4)`,
        [propertyId, orgId, addressNormalized, contactId],
      );
      await client.query(
        `insert into public.sequences (id, org_id, name)
         values ($1, $2, $3)`,
        [sequenceId, orgId, `Switchboard sequence ${sequenceId}`],
      );
      await client.query(
        `insert into public.sequence_enrollments (
           id, org_id, sequence_id, property_id, contact_id, status, next_run_at
         ) values ($1, $2, $3, $4, $5, 'active', now())`,
        [enrollmentId, orgId, sequenceId, propertyId, contactId],
      );
    }
  }

  return { orgId, consumerId, contactIds, propertyIds, enrollmentIds, phone };
}

type ApplyOverrides = {
  idempotencyKey?: string;
  requestHash?: string;
  propertyDisposition?: string | null;
  globalDnc?: boolean;
  evidenceCategory?: string;
  addressNormalized?: string | null;
  manualReview?: boolean;
};

async function applyPreference(
  fixture: Fixture,
  overrides: ApplyOverrides = {},
  client = pg,
): Promise<Record<string, unknown>> {
  const key = overrides.idempotencyKey ?? crypto.randomUUID();
  const category =
    overrides.evidenceCategory ??
    (overrides.globalDnc
      ? "explicit_do_not_contact"
      : "explicit_not_interested");
  const intentMarkerId =
    category === "explicit_not_interested"
      ? "analysis:property_disposition"
      : category === "explicit_do_not_contact"
        ? "analysis:global_dnc_requested"
        : "analysis:both";
  const evidenceHash = createHash("sha256")
    .update(
      `switchboard_contact_preference_v1\0${key}\0${category}\0${intentMarkerId}`,
      "utf8",
    )
    .digest("hex");
  const result = await client.query<{ result: Record<string, unknown> }>(
    `select public.apply_switchboard_contact_preferences(
       $1, $2, $3, $4, 'provider_call', 'contact_preference.explicit',
       $5, $6, $7, null, now(), $8, $9, $10, $11, $12, $13, $14,
       $15, $16, $17, $18
     ) as result`,
    [
      fixture.orgId,
      fixture.consumerId,
      key,
      overrides.requestHash ?? "a".repeat(64),
      `source-${key}`,
      `call-${key}`.slice(0, 128),
      intentMarkerId,
      `correlation-${key}`.slice(0, 128),
      fixture.phone,
      overrides.propertyDisposition === undefined
        ? "not_interested"
        : overrides.propertyDisposition,
      overrides.globalDnc ?? false,
      overrides.manualReview ?? false,
      category,
      evidenceHash,
      overrides.addressNormalized ?? null,
      overrides.addressNormalized ? "Kansas City" : null,
      overrides.addressNormalized ? "MO" : null,
      overrides.addressNormalized ? "64108" : null,
    ],
  );
  return result.rows[0].result;
}

async function expectBlocked<T>(promise: Promise<T>): Promise<void> {
  const result = await Promise.race([
    promise.then(() => "settled", () => "settled"),
    new Promise<"blocked">((resolve) =>
      setTimeout(() => resolve("blocked"), 50),
    ),
  ]);
  expect(result).toBe("blocked");
}

async function expectSettled<T>(promise: Promise<T>): Promise<T> {
  const result = await Promise.race([
    promise.then((value) => ({ status: "settled" as const, value })),
    new Promise<{ status: "timeout" }>((resolve) =>
      setTimeout(() => resolve({ status: "timeout" }), 200),
    ),
  ]);
  expect(result.status).toBe("settled");
  if (result.status !== "settled") {
    throw new Error("ordinary writer unexpectedly blocked");
  }
  return result.value;
}

beforeAll(async () => {
  pg = new Client({ connectionString: testDbUrl() });
  await pg.connect();
  await pg.query(migrationSql);
});

beforeEach(async () => {
  await pg.query("begin");
  transactionOpen = true;
  await setServiceRole();
});

afterEach(async () => {
  if (transactionOpen) await pg.query("rollback");
  transactionOpen = false;
});

afterAll(async () => {
  await pg.end();
});

describe("Switchboard contact preference database contract", () => {
  it("accepts only the dedicated consumer type without a lead source", async () => {
    const fixture = await seedFixture();
    const consumer = await pg.query(
      "select consumer_type, default_source from public.webhook_consumers where id = $1",
      [fixture.consumerId],
    );
    expect(consumer.rows[0]).toEqual({
      consumer_type: "switchboard_contact_preference",
      default_source: null,
    });
  });

  it("installs shared ordinary-write and exclusive global-DNC barriers exactly", async () => {
    const definitions = await pg.query<{ proname: string; definition: string }>(
      `select p.proname, pg_get_functiondef(p.oid) as definition
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname in (
           'acquire_global_dnc_write_barrier',
           'apply_switchboard_contact_preferences'
         )`,
    );
    const ordinary = definitions.rows.find(
      (row) => row.proname === "acquire_global_dnc_write_barrier",
    )?.definition;
    const dnc = definitions.rows.find(
      (row) => row.proname === "apply_switchboard_contact_preferences",
    )?.definition;
    expect(ordinary).toContain("pg_advisory_xact_lock_shared");
    expect(ordinary).not.toMatch(/pg_advisory_xact_lock\s*\(/);
    expect(dnc).toMatch(/pg_advisory_xact_lock\s*\(/);
    expect(dnc).not.toContain("pg_advisory_xact_lock_shared");
    expect(dnc).not.toMatch(/lock table public\./i);
  });

  it("applies not_interested to one address-resolved property and pauses only its automation", async () => {
    const fixture = await seedFixture(pg, { propertiesPerContact: 2 });
    await pg.query(
      "update public.properties set outreach_dispo = 'opted_out' where id = $1",
      [fixture.propertyIds[1]],
    );
    const result = await applyPreference(fixture, {
      addressNormalized: "100 test st",
    });
    expect(result).toEqual({ outcome: "applied" });

    const properties = await pg.query(
      `select id, outreach_dispo, is_dnc_locked
       from public.properties where id = any($1::uuid[]) order by id`,
      [fixture.propertyIds],
    );
    const resolved = properties.rows.find((row) => row.id === fixture.propertyIds[0]);
    const untouched = properties.rows.find((row) => row.id === fixture.propertyIds[1]);
    expect(resolved).toMatchObject({
      outreach_dispo: "not_interested",
      is_dnc_locked: false,
    });
    expect(untouched).toMatchObject({
      outreach_dispo: "opted_out",
      is_dnc_locked: false,
    });

    const enrollments = await pg.query(
      `select property_id, status, pause_reason
       from public.sequence_enrollments where id = any($1::uuid[])`,
      [fixture.enrollmentIds],
    );
    expect(enrollments.rows.find((row) => row.property_id === fixture.propertyIds[0]))
      .toMatchObject({ status: "paused", pause_reason: "not_interested" });
    expect(enrollments.rows.find((row) => row.property_id === fixture.propertyIds[1]))
      .toMatchObject({ status: "active", pause_reason: null });
  });

  it("fails closed on zero, ambiguous, and conflicting property matches", async () => {
    const zero = await seedFixture();
    zero.phone = "+18165559999";
    await expect(applyPreference(zero)).resolves.toEqual({
      outcome: "preference_not_applied",
    });

    const ambiguous = await seedFixture(pg, { propertiesPerContact: 2 });
    await expect(applyPreference(ambiguous)).resolves.toEqual({
      outcome: "preference_not_applied",
    });
    await expect(
      applyPreference(ambiguous, { addressNormalized: "999 conflict st" }),
    ).resolves.toEqual({ outcome: "preference_not_applied" });

    const unchanged = await pg.query(
      `select count(*)::integer as changed from public.properties
       where id = any($1::uuid[]) and outreach_dispo is not null`,
      [ambiguous.propertyIds],
    );
    expect(unchanged.rows[0].changed).toBe(0);
  });

  it("blocks manual-review property intent but still applies explicit global DNC", async () => {
    const propertyOnly = await seedFixture();
    await expect(
      applyPreference(propertyOnly, { manualReview: true }),
    ).resolves.toEqual({ outcome: "preference_not_applied" });
    const unchanged = await pg.query(
      "select outreach_dispo from public.properties where id = $1",
      [propertyOnly.propertyIds[0]],
    );
    expect(unchanged.rows[0].outreach_dispo).toBeNull();

    const global = await seedFixture();
    await expect(
      applyPreference(global, {
        manualReview: true,
        globalDnc: true,
        evidenceCategory: "explicit_not_interested_and_do_not_contact",
      }),
    ).resolves.toEqual({ outcome: "applied" });
    const ratcheted = await pg.query(
      `select c.do_not_contact, p.outreach_dispo
       from public.contacts c
       join public.properties p on p.homeowner_contact_id = c.id
       where c.id = $1`,
      [global.contactIds[0]],
    );
    expect(ratcheted.rows[0].do_not_contact).toBe(true);
    expect(ratcheted.rows[0].outreach_dispo).toBeNull();
  });

  it("rejects both-evidence requests missing either preference flag", async () => {
    const fixture = await seedFixture();
    await pg.query("savepoint partial_both_no_global");
    await expect(
      applyPreference(fixture, {
        evidenceCategory: "explicit_not_interested_and_do_not_contact",
      }),
    ).rejects.toThrow(/invalid switchboard preference request/i);
    await pg.query("rollback to savepoint partial_both_no_global");

    await pg.query("savepoint partial_both_no_property");
    await expect(
      applyPreference(fixture, {
        propertyDisposition: null,
        globalDnc: true,
        evidenceCategory: "explicit_not_interested_and_do_not_contact",
      }),
    ).rejects.toThrow(/invalid switchboard preference request/i);
    await pg.query("rollback to savepoint partial_both_no_property");
  });

  it("persists zero-contact global DNC, replays it, and ratchets later inserts in all phone slots", async () => {
    const fixture = await seedFixture();
    const registryPhones = [
      "+18165551001",
      "+18165551002",
      "+18165551003",
    ];
    for (const [index, phone] of registryPhones.entries()) {
      fixture.phone = phone;
      const key = `registry-slot-${index + 1}`;
      await expect(
        applyPreference(fixture, {
          idempotencyKey: key,
          propertyDisposition: null,
          globalDnc: true,
        }),
      ).resolves.toEqual({ outcome: "applied" });
      await expect(
        applyPreference(fixture, {
          idempotencyKey: key,
          propertyDisposition: null,
          globalDnc: true,
        }),
      ).resolves.toEqual({ outcome: "replayed" });

      const contactId = crypto.randomUUID();
      const propertyId = crypto.randomUUID();
      await pg.query(
        `insert into public.contacts (
           id, org_id, first_name, last_name, phone_${index + 1},
           phone_${index + 1}_type
         ) values ($1, $2, 'Later', $4, $3, 'mobile')`,
        [contactId, fixture.orgId, phone, `Import ${index + 1}`],
      );
      await pg.query(
        `insert into public.properties (
           id, org_id, address, address_normalized, city, state, zip,
           status, homeowner_contact_id
         ) values ($1, $2, $3, $3, 'Kansas City', 'MO', '64108',
           'new_lead', $4)`,
        [propertyId, fixture.orgId, `${index + 1} registry st`, contactId],
      );
      const state = await pg.query(
        `select c.do_not_contact, p.is_dnc_locked
         from public.contacts c
         join public.properties p on p.homeowner_contact_id = c.id
         where c.id = $1`,
        [contactId],
      );
      expect(state.rows[0]).toEqual({
        do_not_contact: true,
        is_dnc_locked: true,
      });
    }

    const registry = await pg.query(
      `select count(*)::integer as count
       from public.global_phone_dnc_registry
       where org_id = $1 and phone_e164 = any($2::text[])`,
      [fixture.orgId, registryPhones],
    );
    expect(registry.rows[0].count).toBe(3);
  });

  it("ratchets an existing contact and linked property when an import updates a registered phone", async () => {
    const fixture = await seedFixture();
    const registeredPhone = "+18165551004";
    const registryRequest = { ...fixture, phone: registeredPhone };
    await applyPreference(registryRequest, {
      propertyDisposition: null,
      globalDnc: true,
    });

    await pg.query(
      `update public.contacts
       set phone_2 = $1, phone_2_type = 'mobile'
       where id = $2`,
      [registeredPhone, fixture.contactIds[0]],
    );
    const state = await pg.query(
      `select c.do_not_contact, p.is_dnc_locked
       from public.contacts c
       join public.properties p on p.homeowner_contact_id = c.id
       where c.id = $1`,
      [fixture.contactIds[0]],
    );
    expect(state.rows[0]).toEqual({
      do_not_contact: true,
      is_dnc_locked: true,
    });
  });

  it("makes the all-channel phone registry append-only and never clears its ratchet", async () => {
    const fixture = await seedFixture();
    await applyPreference(fixture, {
      propertyDisposition: null,
      globalDnc: true,
    });
    await pg.query("savepoint registry_clear");
    await expect(
      pg.query(
        "delete from public.global_phone_dnc_registry where org_id = $1 and phone_e164 = $2",
        [fixture.orgId, fixture.phone],
      ),
    ).rejects.toThrow(/GLOBAL_PHONE_DNC_LOCKED/);
    await pg.query("rollback to savepoint registry_clear");
    const registry = await pg.query(
      "select count(*)::integer as count from public.global_phone_dnc_registry where org_id = $1 and phone_e164 = $2",
      [fixture.orgId, fixture.phone],
    );
    expect(registry.rows[0].count).toBe(1);
  });

  it.skipIf(process.env.SWITCHBOARD_ISOLATED_TEST_DB !== "1")(
    "serializes contact, property, and enrollment phantom writes around global DNC",
    async () => {
      await pg.query("commit");
      transactionOpen = false;
      const connectionString = testDbUrl();

      // Ordinary writers take compatible shared locks. An unrelated org-B
      // contact update must finish while org-A still holds its transaction.
      const ordinaryA = await seedFixture(pg);
      const ordinaryB = await seedFixture(pg);
      const writerA = new Client({ connectionString });
      const writerB = new Client({ connectionString });
      await Promise.all([writerA.connect(), writerB.connect()]);
      try {
        await writerA.query("begin");
        await writerA.query(
          "update public.properties set follow_up_at = now() where id = $1",
          [ordinaryA.propertyIds[0]],
        );
        await writerB.query("begin");
        const unrelatedWrite = writerB.query(
          "update public.contacts set last_name = last_name || ' concurrent' where id = $1",
          [ordinaryB.contactIds[0]],
        );
        await expectSettled(unrelatedWrite);
        await writerB.query("commit");
        await writerA.query("commit");
      } finally {
        await Promise.all([writerA.end(), writerB.end()]);
      }

      // Writer first: a contact insert remains visible to the waiting DNC scan.
      const insertFixture = await seedFixture(pg);
      const insertPhone = "+18165552001";
      const insertContactId = crypto.randomUUID();
      const contactWriter = new Client({ connectionString });
      const contactDnc = new Client({ connectionString });
      await Promise.all([contactWriter.connect(), contactDnc.connect()]);
      try {
        await contactWriter.query("begin");
        await contactWriter.query(
          `insert into public.contacts (
             id, org_id, first_name, last_name, phone_2, phone_2_type
           ) values ($1, $2, 'Race', 'Contact insert', $3, 'mobile')`,
          [insertContactId, insertFixture.orgId, insertPhone],
        );
        await contactDnc.query("begin");
        await setServiceRole(contactDnc);
        const dncPromise = applyPreference(
          { ...insertFixture, phone: insertPhone },
          {
            idempotencyKey: "race-contact-insert-dnc",
            propertyDisposition: null,
            globalDnc: true,
          },
          contactDnc,
        );
        await expectBlocked(dncPromise);
        await contactWriter.query("commit");
        await expect(dncPromise).resolves.toEqual({ outcome: "applied" });
        await contactDnc.query("commit");
      } finally {
        await Promise.all([contactWriter.end(), contactDnc.end()]);
      }
      const insertedContact = await pg.query(
        "select do_not_contact from public.contacts where id = $1",
        [insertContactId],
      );
      expect(insertedContact.rows[0].do_not_contact).toBe(true);

      // Exact historical inverse order: the writer changes a property, DNC
      // begins, then the same writer changes the contact. The statement-level
      // advisory barrier makes DNC wait without holding a contact lock, so the
      // writer can finish and DNC can ratchet afterward without 40P01.
      const inverseFixture = await seedFixture(pg);
      const inverseWriter = new Client({ connectionString });
      const inverseDnc = new Client({ connectionString });
      await Promise.all([inverseWriter.connect(), inverseDnc.connect()]);
      try {
        await inverseWriter.query("begin");
        await inverseWriter.query(
          "update public.properties set follow_up_at = now() where id = $1",
          [inverseFixture.propertyIds[0]],
        );
        await inverseDnc.query("begin");
        await setServiceRole(inverseDnc);
        const inverseDncPromise = applyPreference(
          inverseFixture,
          {
            idempotencyKey: "race-property-first-contact-second-dnc",
            propertyDisposition: null,
            globalDnc: true,
          },
          inverseDnc,
        );
        await expectBlocked(inverseDncPromise);
        await inverseWriter.query(
          "update public.contacts set last_name = last_name || ' updated' where id = $1",
          [inverseFixture.contactIds[0]],
        );
        await inverseWriter.query("commit");
        await expect(inverseDncPromise).resolves.toEqual({
          outcome: "applied",
        });
        await inverseDnc.query("commit");
      } finally {
        await Promise.all([inverseWriter.end(), inverseDnc.end()]);
      }
      const inverseState = await pg.query(
        `select c.do_not_contact, p.is_dnc_locked
         from public.contacts c
         join public.properties p on p.homeowner_contact_id = c.id
         where c.id = $1`,
        [inverseFixture.contactIds[0]],
      );
      expect(inverseState.rows[0]).toEqual({
        do_not_contact: true,
        is_dnc_locked: true,
      });

      // DNC first: a phone update waits, then its trigger sees the registry.
      const updateFixture = await seedFixture(pg);
      const updatePhone = "+18165552002";
      const updateDnc = new Client({ connectionString });
      const contactUpdater = new Client({ connectionString });
      await Promise.all([updateDnc.connect(), contactUpdater.connect()]);
      try {
        await updateDnc.query("begin");
        await setServiceRole(updateDnc);
        await expect(
          applyPreference(
            { ...updateFixture, phone: updatePhone },
            {
              idempotencyKey: "race-contact-update-dnc",
              propertyDisposition: null,
              globalDnc: true,
            },
            updateDnc,
          ),
        ).resolves.toEqual({ outcome: "applied" });
        await contactUpdater.query("begin");
        const updatePromise = contactUpdater.query(
          `update public.contacts
           set phone_3 = $1, phone_3_type = 'mobile'
           where id = $2`,
          [updatePhone, updateFixture.contactIds[0]],
        );
        await expectBlocked(updatePromise);
        await updateDnc.query("commit");
        await updatePromise;
        await contactUpdater.query("commit");
      } finally {
        await Promise.all([updateDnc.end(), contactUpdater.end()]);
      }
      const updatedState = await pg.query(
        `select c.do_not_contact, p.is_dnc_locked
         from public.contacts c
         join public.properties p on p.homeowner_contact_id = c.id
         where c.id = $1`,
        [updateFixture.contactIds[0]],
      );
      expect(updatedState.rows[0]).toEqual({
        do_not_contact: true,
        is_dnc_locked: true,
      });

      // Writer first: a property insert becomes visible before the DNC scan.
      const propertyFixture = await seedFixture(pg);
      const racePropertyId = crypto.randomUUID();
      const propertyWriter = new Client({ connectionString });
      const propertyDnc = new Client({ connectionString });
      await Promise.all([propertyWriter.connect(), propertyDnc.connect()]);
      try {
        await propertyWriter.query("begin");
        await propertyWriter.query(
          `insert into public.properties (
             id, org_id, address, address_normalized, city, state, zip,
             status, homeowner_contact_id
           ) values ($1, $2, 'race property st', 'race property st',
             'Kansas City', 'MO', '64108', 'new_lead', $3)`,
          [
            racePropertyId,
            propertyFixture.orgId,
            propertyFixture.contactIds[0],
          ],
        );
        await propertyDnc.query("begin");
        await setServiceRole(propertyDnc);
        const dncPromise = applyPreference(
          propertyFixture,
          {
            idempotencyKey: "race-property-insert-dnc",
            propertyDisposition: null,
            globalDnc: true,
          },
          propertyDnc,
        );
        await expectBlocked(dncPromise);
        await propertyWriter.query("commit");
        await expect(dncPromise).resolves.toEqual({ outcome: "applied" });
        await propertyDnc.query("commit");
      } finally {
        await Promise.all([propertyWriter.end(), propertyDnc.end()]);
      }
      const raceProperty = await pg.query(
        "select is_dnc_locked from public.properties where id = $1",
        [racePropertyId],
      );
      expect(raceProperty.rows[0].is_dnc_locked).toBe(true);

      // DNC first: a late enrollment waits, then inserts already opted out.
      const enrollmentFixture = await seedFixture(pg);
      const sequenceId = crypto.randomUUID();
      const enrollmentId = crypto.randomUUID();
      await pg.query(
        "insert into public.sequences (id, org_id, name) values ($1, $2, $3)",
        [sequenceId, enrollmentFixture.orgId, `Race sequence ${sequenceId}`],
      );
      const enrollmentDnc = new Client({ connectionString });
      const enrollmentWriter = new Client({ connectionString });
      await Promise.all([enrollmentDnc.connect(), enrollmentWriter.connect()]);
      try {
        await enrollmentDnc.query("begin");
        await setServiceRole(enrollmentDnc);
        await expect(
          applyPreference(
            enrollmentFixture,
            {
              idempotencyKey: "race-enrollment-insert-dnc",
              propertyDisposition: null,
              globalDnc: true,
            },
            enrollmentDnc,
          ),
        ).resolves.toEqual({ outcome: "applied" });
        await enrollmentWriter.query("begin");
        const insertPromise = enrollmentWriter.query(
          `insert into public.sequence_enrollments (
             id, org_id, sequence_id, property_id, contact_id, status,
             next_run_at
           ) values ($1, $2, $3, $4, $5, 'active', now())`,
          [
            enrollmentId,
            enrollmentFixture.orgId,
            sequenceId,
            enrollmentFixture.propertyIds[0],
            enrollmentFixture.contactIds[0],
          ],
        );
        await expectBlocked(insertPromise);
        await enrollmentDnc.query("commit");
        await insertPromise;
        await enrollmentWriter.query("commit");
      } finally {
        await Promise.all([enrollmentDnc.end(), enrollmentWriter.end()]);
      }
      const enrollment = await pg.query(
        `select status, pause_reason, next_run_at
         from public.sequence_enrollments where id = $1`,
        [enrollmentId],
      );
      expect(enrollment.rows[0]).toEqual({
        status: "opted_out",
        pause_reason: "dnc",
        next_run_at: null,
      });
    },
  );

  it("replays the same key and hash but conflicts generically for a changed body", async () => {
    const fixture = await seedFixture();
    const key = "stable-event";
    await expect(applyPreference(fixture, { idempotencyKey: key })).resolves.toEqual({
      outcome: "applied",
    });
    await expect(applyPreference(fixture, { idempotencyKey: key })).resolves.toEqual({
      outcome: "replayed",
    });
    await expect(
      applyPreference(fixture, {
        idempotencyKey: key,
        requestHash: "c".repeat(64),
      }),
    ).resolves.toEqual({ outcome: "idempotency_conflict" });
  });

  it("replays a prior no-match as preference_not_applied and never weakens an opt-out", async () => {
    const noMatch = await seedFixture();
    noMatch.phone = "+18165559998";
    const noMatchKey = "stable-no-match";
    await expect(
      applyPreference(noMatch, { idempotencyKey: noMatchKey }),
    ).resolves.toEqual({ outcome: "preference_not_applied" });
    await expect(
      applyPreference(noMatch, { idempotencyKey: noMatchKey }),
    ).resolves.toEqual({ outcome: "preference_not_applied" });

    const optedOut = await seedFixture();
    await pg.query(
      "update public.properties set outreach_dispo = 'opted_out' where id = $1",
      [optedOut.propertyIds[0]],
    );
    await expect(applyPreference(optedOut)).resolves.toEqual({ outcome: "applied" });
    const property = await pg.query(
      "select outreach_dispo from public.properties where id = $1",
      [optedOut.propertyIds[0]],
    );
    expect(property.rows[0].outreach_dispo).toBe("opted_out");
    const enrollment = await pg.query(
      "select status, pause_reason from public.sequence_enrollments where id = $1",
      [optedOut.enrollmentIds[0]],
    );
    expect(enrollment.rows[0]).toEqual({ status: "active", pause_reason: null });
  });

  it("ratchets every same-phone contact, locks linked properties, and permanently pauses all outreach", async () => {
    const fixture = await seedFixture(pg, { contacts: 2 });
    const result = await applyPreference(fixture, {
      propertyDisposition: null,
      globalDnc: true,
    });
    expect(result).toEqual({ outcome: "applied" });

    const contacts = await pg.query(
      "select bool_and(do_not_contact) as all_dnc from public.contacts where id = any($1::uuid[])",
      [fixture.contactIds],
    );
    expect(contacts.rows[0].all_dnc).toBe(true);
    const properties = await pg.query(
      "select bool_and(is_dnc_locked) as all_locked from public.properties where id = any($1::uuid[])",
      [fixture.propertyIds],
    );
    expect(properties.rows[0].all_locked).toBe(true);
    const enrollments = await pg.query(
      `select count(*)::integer as stopped from public.sequence_enrollments
       where id = any($1::uuid[]) and status = 'opted_out'
         and pause_reason = 'dnc' and next_run_at is null`,
      [fixture.enrollmentIds],
    );
    expect(enrollments.rows[0].stopped).toBe(fixture.enrollmentIds.length);

    await pg.query("savepoint dnc_clear_attempt");
    await expect(
      pg.query("update public.contacts set do_not_contact = false where id = $1", [
        fixture.contactIds[0],
      ]),
    ).rejects.toThrow(/DNC_LOCKED/i);
    await pg.query("rollback to savepoint dnc_clear_attempt");

    const audit = await pg.query<{ payload: Record<string, unknown> }>(
      `select payload from public.webhook_events
       where org_id = $1 and provider = 'switchboard'`,
      [fixture.orgId],
    );
    const serialized = JSON.stringify(audit.rows[0].payload);
    const phoneHash = createHash("sha256").update(fixture.phone).digest("hex");
    const addressHash = createHash("sha256")
      .update("100 test st")
      .digest("hex");
    expect(serialized).not.toContain(fixture.phone);
    expect(serialized).not.toContain("100 test st");
    expect(serialized).not.toContain(phoneHash);
    expect(serialized).not.toContain(addressHash);
    expect(serialized).not.toContain("caller_phone_sha256");
    expect(serialized).not.toContain("address_sha256");
    expect(serialized).not.toContain("transcript");
  });

  it("applies independent not_interested and global DNC atomically with DNC precedence", async () => {
    const fixture = await seedFixture();
    const result = await applyPreference(fixture, {
      globalDnc: true,
      evidenceCategory: "explicit_not_interested_and_do_not_contact",
    });
    expect(result).toEqual({ outcome: "applied" });
    const state = await pg.query(
      `select p.outreach_dispo, p.is_dnc_locked, c.do_not_contact
       from public.properties p join public.contacts c on c.id = p.homeowner_contact_id
       where p.id = $1`,
      [fixture.propertyIds[0]],
    );
    expect(state.rows[0]).toEqual({
      outreach_dispo: "not_interested",
      is_dnc_locked: true,
      do_not_contact: true,
    });
  });

  it.skipIf(process.env.SWITCHBOARD_ISOLATED_TEST_DB !== "1")(
    "concurrent not_interested and DNC requests always converge on global DNC",
    async () => {
      // This case commits a synthetic DNC fixture and therefore runs only on
      // a disposable database created for this migration rehearsal.
      await pg.query("commit");
      transactionOpen = false;
      const fixture = await seedFixture(pg);
      const connectionString = testDbUrl();
      const propertyClient = new Client({ connectionString });
      const dncClient = new Client({ connectionString });
      await Promise.all([propertyClient.connect(), dncClient.connect()]);
      try {
        await Promise.all([
          propertyClient.query("begin"),
          dncClient.query("begin"),
        ]);
        await Promise.all([
          setServiceRole(propertyClient),
          setServiceRole(dncClient),
        ]);
        const propertyResult = await applyPreference(
          fixture,
          { idempotencyKey: "concurrent-property" },
          propertyClient,
        );
        const dncPromise = applyPreference(
          fixture,
          {
            idempotencyKey: "concurrent-dnc",
            propertyDisposition: null,
            globalDnc: true,
          },
          dncClient,
        );
        // The DNC transaction is now contending on the contact lock held by
        // the still-uncommitted property transaction. Once released, it must
        // observe the new state and ratchet over it.
        await new Promise((resolve) => setTimeout(resolve, 50));
        await propertyClient.query("commit");
        const dncResult = await dncPromise;
        await dncClient.query("commit");
        expect(propertyResult).toEqual({ outcome: "applied" });
        expect(dncResult).toEqual({ outcome: "applied" });
      } finally {
        await Promise.all([propertyClient.end(), dncClient.end()]);
      }

      const state = await pg.query(
        `select p.is_dnc_locked, c.do_not_contact, e.status, e.pause_reason
         from public.properties p
         join public.contacts c on c.id = p.homeowner_contact_id
         join public.sequence_enrollments e on e.property_id = p.id
         where p.id = $1`,
        [fixture.propertyIds[0]],
      );
      expect(state.rows[0]).toMatchObject({
        is_dnc_locked: true,
        do_not_contact: true,
        status: "opted_out",
        pause_reason: "dnc",
      });
    },
  );
});
