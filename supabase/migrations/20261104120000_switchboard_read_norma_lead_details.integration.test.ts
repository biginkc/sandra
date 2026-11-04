import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { requireLoopbackPostgresUrl } from "../../src/lib/testing/loopback-postgres-url";

/**
 * switchboard_read.norma_lead_details (20261104120000).
 *
 * Runs on a disposable loopback database with the full migration chain applied, inside one transaction that is always
 * rolled back. switchboard_read itself is provisioned by Switchboard's operator script (Switchboard repo,
 * db/sandra/0001_switchboard_read.sql), so the fixture below recreates the parts of it this view depends on: the two
 * roles, the schema, and the org-scoped owner policies on properties/contacts/messages/organizations. Then it runs this
 * migration and reads the view as sandra_switchboard_reader.
 */
const url = requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL ?? "");
const migrationSql = readFileSync(
  path.resolve(__dirname, "20261104120000_switchboard_read_norma_lead_details.sql"),
  "utf8",
);

const CONTRACT: [string, string][] = [
  ["property_id", "uuid"],
  ["org_id", "uuid"],
  ["owner_full_name", "text"],
  ["address", "text"],
  ["city", "text"],
  ["state", "text"],
  ["zip", "text"],
  ["beds", "numeric"],
  ["baths", "numeric"],
  ["sqft", "numeric"],
  ["year_built", "integer"],
  ["arv", "numeric"],
  ["mortgage_balance", "numeric"],
  ["equity_estimate", "numeric"],
  ["equity_pct", "numeric"],
  ["motivation_level", "text"],
  ["is_vacant", "boolean"],
  ["absentee_flag", "boolean"],
  ["distress_flags", "text[]"],
  ["notes", "text"],
  ["last_inbound_text", "text"],
  ["last_inbound_at", "timestamp with time zone"],
  ["last_contact_at", "timestamp with time zone"],
  ["last_contact_kind", "text"],
];

const orgA = randomUUID();
const orgB = randomUUID();
const ids = {
  live: randomUUID(), // org A, full data
  entity: randomUUID(), // org A, entity owner, call is the latest contact
  quiet: randomUUID(), // org A, no contact history at all
  deleted: randomUUID(), // org A, soft-deleted
  training: randomUUID(), // org A, training lead
  otherOrg: randomUUID(), // org B
};
const contacts = { person: randomUUID(), entity: randomUUID(), quiet: randomUUID(), b: randomUUID() };

let db: Client;

type PlanNode = { "Node Type": string; "Relation Name"?: string; "Index Cond"?: string; "Recheck Cond"?: string; Plans?: PlanNode[] };

// Every catalog fact the migration sets, for before/after comparisons.
const STATE_SQL = `select
    (select pg_get_viewdef('switchboard_read.norma_lead_details'::regclass)) as viewdef,
    (select row(c.relowner::regrole::text, c.relacl::text, c.reloptions::text)::text from pg_class c
      where c.oid = 'switchboard_read.norma_lead_details'::regclass) as view_meta,
    (select relacl::text from pg_class where oid = 'public.call_activities'::regclass) as call_activities_acl,
    (select string_agg(format('%s|%s|%s|%s', tablename, policyname, roles, qual), ',' order by tablename, policyname)
       from pg_policies where policyname = 'switchboard_read_owner_select') as policies,
    (select string_agg(format('%s|%s|%s|%s|%s', member::regrole, grantor::regrole, admin_option, inherit_option, set_option),
            ',' order by member::regrole::text, grantor::regrole::text)
       from pg_auth_members where roleid = 'switchboard_read_owner'::regrole) as memberships`;

async function asReader<T>(fn: () => Promise<T>): Promise<T> {
  await db.query("savepoint reader");
  await db.query("set local role sandra_switchboard_reader");
  try {
    return await fn();
  } finally {
    await db.query("rollback to savepoint reader");
  }
}

async function readerRows(propertyIds: string[]) {
  return asReader(async () =>
    (await db.query("select * from switchboard_read.norma_lead_details where property_id = any($1::uuid[])", [propertyIds])).rows,
  );
}

async function seed() {
  await db.query("insert into public.organizations(id,name) values ($1,'NLD A'),($2,'NLD B')", [orgA, orgB]);
  await db.query(
    `insert into public.contacts(id,org_id,contact_type,first_name,last_name,entity_name) values
       ($1,$5,'person',' Pat ','Seller',null),
       ($2,$5,'entity',null,null,'Acme Holdings LLC'),
       ($3,$5,'person','Quinn',null,null),
       ($4,$6,'person','Bea','Other',null)`,
    [contacts.person, contacts.entity, contacts.quiet, contacts.b, orgA, orgB],
  );
  const prop = `insert into public.properties(id,org_id,address,city,state,zip,status,homeowner_contact_id,beds,baths,sqft,
      year_built,arv,mortgage_balance,equity_estimate,motivation_level,is_vacant,absentee_flag,distress_flags,notes)
    values ($1,$2,$3,'Kansas City','MO','64111','new_lead',$4,3,2.5,1450,1962,210000,80000,130000,'hot',true,false,
      array['pre_foreclosure','tax_lien'],'Roof is old')`;
  await db.query(prop, [ids.live, orgA, "1 Live St", contacts.person]);
  await db.query(prop, [ids.entity, orgA, "2 Entity St", contacts.entity]);
  await db.query(prop, [ids.quiet, orgA, "3 Quiet St", contacts.quiet]);
  await db.query(prop, [ids.deleted, orgA, "4 Deleted St", contacts.quiet]);
  await db.query(prop, [ids.otherOrg, orgB, "6 Other Org St", contacts.b]);
  await db.query("update public.properties set deleted_at = now() where id = $1", [ids.deleted]);
  // Training leads are server-created through their own guard; the view must hide them whatever their data.
  await db.query("alter table public.properties disable trigger user");
  await db.query(
    "insert into public.properties(id,org_id,address,state,status,is_training) values ($1,$2,'5 Training St','MO','new_lead',true)",
    [ids.training, orgA],
  );
  await db.query("alter table public.properties enable trigger user");

  const msg = `insert into public.messages(org_id,property_id,contact_id,channel,direction,status,body,from_address,to_address,
      created_at,sent_at) values ($1,$2,$3,'sms',$4,$5,$6,'+18165550100','+18165550199',$7::timestamptz,$8::timestamptz)`;
  // ids.live: older inbound, newer inbound (the one to show), a later sent outbound (latest contact), a still-queued
  // outbound and an even later failed one (both never went out, so not contact).
  await db.query(msg, [orgA, ids.live, contacts.person, "inbound", "received", "older reply", "2026-11-01T10:00:00Z", null]);
  await db.query(msg, [orgA, ids.live, contacts.person, "inbound", "received", "newest reply", "2026-11-02T10:00:00Z", null]);
  await db.query(msg, [orgA, ids.live, contacts.person, "outbound", "delivered", "our text", "2026-11-02T11:00:00Z", "2026-11-02T11:00:05Z"]);
  await db.query(msg, [orgA, ids.live, contacts.person, "outbound", "queued", "future drip", "2026-11-03T09:00:00Z", null]);
  await db.query(msg, [orgA, ids.live, contacts.person, "outbound", "failed", "never sent", "2026-11-03T10:00:00Z", null]);
  // ids.entity: one inbound, then a later call.
  await db.query(msg, [orgA, ids.entity, contacts.entity, "inbound", "received", "entity reply", "2026-11-01T08:00:00Z", null]);
  await db.query(
    `insert into public.call_activities(org_id,property_id,contact_id,jitter_attempt_id,jitter_session_id,started_at,ended_at,provider,direction)
     values ($1,$2,$3,$4,'nld-session','2026-11-01T09:00:00Z','2026-11-01T09:02:00Z','jitter','outbound')`,
    [orgA, ids.entity, contacts.entity, `nld-${randomUUID()}`],
  );
  // ids.otherOrg: org B data that must never be visible.
  await db.query(msg, [orgB, ids.otherOrg, contacts.b, "inbound", "received", "org b reply", "2026-11-02T12:00:00Z", null]);
}

async function provisionSwitchboardRead() {
  // Mirrors the operator script's roles, schema and owner policies (see header).
  await db.query(`create role switchboard_read_owner nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls noreplication`);
  await db.query(`create role sandra_switchboard_reader login nosuperuser nocreatedb nocreaterole noinherit nobypassrls
    noreplication connection limit 3`);
  await db.query("grant switchboard_read_owner to current_user with inherit true, set true");
  // Test-only: lets this session SET ROLE to the reader (no inherit, so it gains none of the reader's rights).
  await db.query("grant sandra_switchboard_reader to current_user with inherit false, set true");
  for (const table of ["properties", "contacts", "messages", "organizations"]) {
    const column = table === "organizations" ? "id" : "org_id";
    await db.query(`grant select on public.${table} to switchboard_read_owner`);
    await db.query(`create policy switchboard_read_owner_select on public.${table} for select to switchboard_read_owner
      using (${column} = '${orgA}'::uuid)`);
  }
  await db.query("create schema switchboard_read authorization switchboard_read_owner");
  await db.query("revoke all on schema switchboard_read from public");
  await db.query("grant usage on schema switchboard_read to sandra_switchboard_reader");
}

beforeAll(async () => {
  db = new Client({ connectionString: url });
  await db.connect();
  const ready = await db.query(
    `select to_regclass('public.call_activities') is not null
        and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'properties'
                     and column_name = 'is_training') as ok,
            to_regnamespace('switchboard_read') is null
        and not exists (select 1 from pg_roles where rolname in ('switchboard_read_owner', 'sandra_switchboard_reader')) as fresh`,
  );
  if (ready.rows[0].ok !== true) throw new Error("full-chain database required");
  if (ready.rows[0].fresh !== true) throw new Error("this suite provisions switchboard_read itself; use a database without it");
  await db.query("begin");
});

afterAll(async () => {
  await db?.query("rollback").catch(() => {});
  await db?.end();
});

describe("20261104120000 switchboard_read.norma_lead_details", () => {
  it("is a no-op on a database without switchboard_read", async () => {
    await db.query("savepoint noop");
    try {
      await db.query(migrationSql);
      const { rows } = await db.query("select to_regclass('switchboard_read.norma_lead_details') as v");
      expect(rows[0].v).toBeNull();
      const policy = await db.query(
        "select count(*)::int as n from pg_policies where tablename = 'call_activities' and policyname = 'switchboard_read_owner_select'",
      );
      expect(policy.rows[0].n).toBe(0);
    } finally {
      await db.query("rollback to savepoint noop");
    }
  });

  it("provisions on a switchboard_read database and is idempotent", async () => {
    await seed();
    await provisionSwitchboardRead();
    await db.query(migrationSql);
    const before = (await db.query(STATE_SQL)).rows[0];
    await db.query(migrationSql); // re-run must succeed and change nothing
    const after = (await db.query(STATE_SQL)).rows[0];
    expect(after).toEqual(before);
    expect(before.viewdef).toContain("call_activities");

    const view = await db.query(
      `select c.relkind, pg_get_userbyid(c.relowner) as owner, c.reloptions
         from pg_class c where c.oid = 'switchboard_read.norma_lead_details'::regclass`,
    );
    expect(view.rows[0]).toEqual({ relkind: "v", owner: "switchboard_read_owner", reloptions: ["security_barrier=true"] });

    const policy = await db.query(
      `select roles::text[] as roles, cmd, qual from pg_policies
        where schemaname = 'public' and tablename = 'call_activities' and policyname = 'switchboard_read_owner_select'`,
    );
    expect(policy.rows).toEqual([{ roles: ["switchboard_read_owner"], cmd: "SELECT", qual: `(org_id = '${orgA}'::uuid)` }]);
  });

  it("refuses to run when the owner policies disagree on the org", async () => {
    await db.query("savepoint mismatch");
    try {
      await db.query(`alter policy switchboard_read_owner_select on public.contacts using (org_id = '${orgB}'::uuid)`);
      await expect(db.query(migrationSql)).rejects.toThrow(
        `switchboard_read_owner_select on public.contacts does not scope to org ${orgA}`,
      );
    } finally {
      await db.query("rollback to savepoint mismatch");
    }
  });

  it("grants itself owner membership only when missing, and revokes it afterwards", async () => {
    await db.query("savepoint membership");
    try {
      const has = async () =>
        (await db.query(
          `select pg_has_role(current_user, 'switchboard_read_owner', 'USAGE') as usage,
                  pg_has_role(current_user, 'switchboard_read_owner', 'SET') as set`,
        )).rows[0];
      const before = (await db.query(STATE_SQL)).rows[0];
      await db.query("set local role switchboard_read_owner");
      await db.query("drop view switchboard_read.norma_lead_details");
      await db.query("reset role");
      // Drop the operator script's membership (granted by this role), leaving only what CREATE ROLE gave the creator.
      await db.query("revoke switchboard_read_owner from current_user granted by current_user");
      expect(await has()).toEqual({ usage: false, set: false });
      const withoutSelfGrant = (
        await db.query("select string_agg(format('%s|%s', member::regrole, grantor::regrole), ',') as m from pg_auth_members where roleid = 'switchboard_read_owner'::regrole")
      ).rows[0].m;

      await db.query(migrationSql);

      const after = (await db.query(STATE_SQL)).rows[0];
      // View, grants and policies recreated identically.
      expect({ ...after, memberships: null }).toEqual({ ...before, memberships: null });
      // Membership is back to exactly what it was before the migration ran: its temporary grant was revoked.
      expect(await has()).toEqual({ usage: false, set: false });
      expect(
        (await db.query("select string_agg(format('%s|%s', member::regrole, grantor::regrole), ',') as m from pg_auth_members where roleid = 'switchboard_read_owner'::regrole")).rows[0].m,
      ).toBe(withoutSelfGrant);
    } finally {
      await db.query("rollback to savepoint membership");
    }
  });

  it("matches the column contract exactly", async () => {
    const { rows } = await db.query<{ column_name: string; type: string }>(
      `select a.attname as column_name, format_type(a.atttypid, a.atttypmod) as type
         from pg_attribute a
        where a.attrelid = 'switchboard_read.norma_lead_details'::regclass and a.attnum > 0 and not a.attisdropped
        order by a.attnum`,
    );
    expect(rows.map((r) => [r.column_name, r.type])).toEqual(CONTRACT);
  });

  it("only the owner and the reader hold privileges on the view, and the reader may only SELECT", async () => {
    const { rows } = await db.query<{ grantee: string; privilege_type: string }>(
      `select grantee, privilege_type from information_schema.role_table_grants
        where table_schema = 'switchboard_read' and table_name = 'norma_lead_details' order by grantee, privilege_type`,
    );
    expect(new Set(rows.map((r) => r.grantee))).toEqual(new Set(["switchboard_read_owner", "sandra_switchboard_reader"]));
    expect(rows.filter((r) => r.grantee === "sandra_switchboard_reader").map((r) => r.privilege_type)).toEqual(["SELECT"]);
    const base = await db.query(
      `select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
          and has_table_privilege('sandra_switchboard_reader', c.oid, 'SELECT, INSERT, UPDATE, DELETE')`,
    );
    expect(base.rows[0].n).toBe(0);
  });

  it("the reader reads the lead: owner name, property facts, latest inbound text, latest contact", async () => {
    const rows = await readerRows([ids.live, ids.entity, ids.quiet]);
    const byId = new Map(rows.map((r) => [r.property_id, r]));

    const live = byId.get(ids.live);
    expect(live).toMatchObject({
      org_id: orgA,
      owner_full_name: "Pat Seller",
      address: "1 Live St",
      city: "Kansas City",
      state: "MO",
      zip: "64111",
      beds: "3",
      baths: "2.5",
      sqft: "1450",
      year_built: 1962,
      arv: "210000",
      mortgage_balance: "80000",
      equity_estimate: "130000",
      motivation_level: "hot",
      is_vacant: true,
      absentee_flag: false,
      distress_flags: ["pre_foreclosure", "tax_lien"],
      notes: "Roof is old",
      last_inbound_text: "newest reply",
      last_contact_kind: "text",
    });
    // equity_pct is a generated column (equity_estimate * 100 / arv).
    expect(Number(live.equity_pct)).toBeCloseTo(61.905, 3);
    expect(live.last_inbound_at.toISOString()).toBe("2026-11-02T10:00:00.000Z");
    // The delivered outbound (sent_at) is the latest contact; queued and failed outbound never went out.
    expect(live.last_contact_at.toISOString()).toBe("2026-11-02T11:00:05.000Z");

    const entity = byId.get(ids.entity);
    expect(entity).toMatchObject({ owner_full_name: "Acme Holdings LLC", last_inbound_text: "entity reply", last_contact_kind: "call" });
    expect(entity.last_contact_at.toISOString()).toBe("2026-11-01T09:00:00.000Z");

    expect(byId.get(ids.quiet)).toMatchObject({
      owner_full_name: "Quinn",
      last_inbound_text: null,
      last_inbound_at: null,
      last_contact_at: null,
      last_contact_kind: null,
    });
  });

  it("hides soft-deleted, training and other-org leads", async () => {
    const rows = await readerRows([ids.deleted, ids.training, ids.otherOrg]);
    expect(rows).toEqual([]);
    const all = await asReader(async () =>
      (await db.query("select distinct org_id from switchboard_read.norma_lead_details")).rows.map((r) => r.org_id),
    );
    expect(all).toEqual([orgA]);
  });

  it("the reader cannot write through the view or reach the base tables", async () => {
    const probes = [
      "update switchboard_read.norma_lead_details set notes = 'x'",
      "delete from switchboard_read.norma_lead_details",
      "insert into switchboard_read.norma_lead_details(property_id) values (gen_random_uuid())",
      "select 1 from public.properties limit 1",
      "select 1 from public.messages limit 1",
      "select 1 from public.call_activities limit 1",
      "update public.properties set notes = notes",
      "create table switchboard_read.probe (id int)",
    ];
    for (const probe of probes) {
      const code = await asReader(async () => {
        await db.query("savepoint probe");
        try {
          await db.query(probe);
          return "succeeded";
        } catch (error) {
          await db.query("rollback to savepoint probe");
          return (error as { code?: string }).code ?? "no code";
        }
      });
      // 42501 = insufficient_privilege. Writes through the view may instead stop at 55000 (the view is not
      // auto-updatable); the reader holds no write privilege on it either way (asserted above).
      const refused = probe.includes("norma_lead_details") && !probe.startsWith("select") ? ["42501", "55000"] : ["42501"];
      expect([probe, refused.includes(code)]).toEqual([probe, true]);
    }
    const writable = await db.query(
      "select has_table_privilege('sandra_switchboard_reader', 'switchboard_read.norma_lead_details', 'INSERT, UPDATE, DELETE, TRUNCATE') as w",
    );
    expect(writable.rows[0].w).toBe(false);
  });

  it("a property_id lookup uses property-keyed index conditions on properties, messages and call_activities", async () => {
    await db.query("savepoint plan");
    try {
      // Give the planner realistic statistics: 300 extra leads with texts and calls, then ANALYZE (sees this transaction's rows).
      await db.query(
        `with p as (
           insert into public.properties(org_id,address,state,status)
           select $1, 'Bulk ' || g, 'MO', 'new_lead' from generate_series(1, 300) g returning id)
         insert into public.messages(org_id,property_id,channel,direction,status,body,created_at)
         select $1, p.id, 'sms', d, case d when 'inbound' then 'received' else 'delivered' end, 'bulk',
                now() - make_interval(mins => g)
           from p, generate_series(1, 8) g, unnest(array['inbound','outbound']) d`,
        [orgA],
      );
      await db.query(
        `insert into public.call_activities(org_id,property_id,contact_id,jitter_attempt_id,jitter_session_id,started_at,provider,direction)
         select $1, p.id, $2, 'bulk-' || p.id || '-' || g, 'bulk-session', now() - make_interval(hours => g), 'jitter', 'outbound'
           from public.properties p, generate_series(1, 4) g where p.org_id = $1 and p.address like 'Bulk %'`,
        [orgA, contacts.quiet],
      );
      await db.query("analyze public.properties, public.contacts, public.messages, public.call_activities");
      const plan = await asReader(async () => {
        const { rows } = await db.query(
          "explain (format json) select * from switchboard_read.norma_lead_details where property_id = any($1::uuid[])",
          [[ids.live, ids.entity]],
        );
        return rows[0]["QUERY PLAN"][0].Plan as PlanNode;
      });
      const nodes: PlanNode[] = [];
      const walk = (node: PlanNode) => {
        if (node["Relation Name"]) nodes.push(node);
        for (const child of node.Plans ?? []) walk(child);
      };
      walk(plan);
      const conds = (relation: string) => nodes.filter((n) => n["Relation Name"] === relation);
      for (const relation of ["properties", "messages", "call_activities"]) {
        expect([relation, conds(relation).some((n) => n["Node Type"] === "Seq Scan")]).toEqual([relation, false]);
      }
      // A bitmap heap scan carries its index condition as "Recheck Cond".
      const cond = (n: PlanNode) => n["Index Cond"] ?? n["Recheck Cond"] ?? "";
      expect(conds("properties").some((n) => /\bid = ANY\b/.test(cond(n)))).toBe(true);
      const messages = conds("messages");
      expect(messages.length).toBeGreaterThanOrEqual(2); // inbound lateral + outbound branch
      for (const node of messages) expect(node["Index Cond"] ?? "").toMatch(/property_id = p\.id/);
      const calls = conds("call_activities");
      expect(calls.length).toBe(1);
      expect(calls[0]["Index Cond"] ?? "").toMatch(/property_id = p\.id/);
    } finally {
      await db.query("rollback to savepoint plan");
    }
  });
});
