import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { requireLoopbackPostgresUrl } from "../../src/lib/testing/loopback-postgres-url";

/**
 * switchboard_read.norma_interested_since (20261119120000).
 *
 * Runs on a disposable loopback database with the full migration chain applied, inside one transaction that is always
 * rolled back. switchboard_read itself is provisioned by Switchboard's operator script (Switchboard repo,
 * db/sandra/0001_switchboard_read.sql), so the fixture below recreates the parts of it this view depends on: the two
 * roles, the schema, the org-scoped owner policies on properties/contacts/messages/organizations, and an
 * interested_call_list stand-in (to prove this migration leaves existing views alone). Then it runs this migration and
 * reads the view as sandra_switchboard_reader.
 */
const url = requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL ?? "");
const migrationSql = readFileSync(
  path.resolve(__dirname, "20261119120000_switchboard_read_norma_interested_since.sql"),
  "utf8",
);

const CONTRACT: [string, string][] = [
  ["property_id", "uuid"],
  ["interested_at", "timestamp with time zone"],
];

const orgA = randomUUID();
const orgB = randomUUID();
const ids = {
  twice: randomUUID(), // org A, became Interested twice (latest wins)
  workflow: randomUUID(), // org A, became Interested only through the My Leads ready_acquisition_offer workflow
  mixed: randomUUID(), // org A, both kinds; the workflow event is the later one
  qualified: randomUUID(), // org A, only a qualified event (no longer counts)
  never: randomUUID(), // org A, status changes but never to interested
  otherOrg: randomUUID(), // org B, became Interested
};

let db: Client;

const STATE_SQL = `select
    (select pg_get_viewdef('switchboard_read.norma_interested_since'::regclass)) as viewdef,
    (select row(c.relowner::regrole::text, c.relacl::text, c.reloptions::text)::text from pg_class c
      where c.oid = 'switchboard_read.norma_interested_since'::regclass) as view_meta,
    (select relacl::text from pg_class where oid = 'public.lead_events'::regclass) as lead_events_acl,
    (select string_agg(format('%s|%s|%s|%s', tablename, policyname, roles, qual), ',' order by tablename, policyname)
       from pg_policies where policyname = 'switchboard_read_owner_select') as policies,
    (select string_agg(format('%s|%s|%s|%s|%s', member::regrole, grantor::regrole, admin_option, inherit_option, set_option),
            ',' order by member::regrole::text, grantor::regrole::text)
       from pg_auth_members where roleid = 'switchboard_read_owner'::regrole) as memberships`;

const OTHER_STATE_SQL = `select
    (select pg_get_viewdef('switchboard_read.interested_call_list'::regclass)) as icl_viewdef,
    (select row(c.relowner::regrole::text, c.relacl::text, c.reloptions::text)::text from pg_class c
      where c.oid = 'switchboard_read.interested_call_list'::regclass) as icl_meta,
    (select string_agg(format('%s|%s|%s|%s', tablename, policyname, roles, qual), ',' order by tablename, policyname)
       from pg_policies where tablename <> 'lead_events') as other_policies,
    (select string_agg(format('%s|%s', relname, relacl), ',' order by relname) from pg_class
      where relnamespace = 'public'::regnamespace and relkind in ('r', 'p', 'v', 'm') and relname <> 'lead_events') as other_acls`;

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
    (await db.query("select * from switchboard_read.norma_interested_since where property_id = any($1::uuid[])", [propertyIds]))
      .rows,
  );
}

async function seed() {
  await db.query("insert into public.organizations(id,name) values ($1,'NIS A'),($2,'NIS B')", [orgA, orgB]);
  const prop = "insert into public.properties(id,org_id,address,state,status) values ($1,$2,$3,'MO','new_lead')";
  await db.query(prop, [ids.twice, orgA, "1 Twice St"]);
  await db.query(prop, [ids.qualified, orgA, "2 Qualified St"]);
  await db.query(prop, [ids.never, orgA, "3 Never St"]);
  await db.query(prop, [ids.workflow, orgA, "5 Workflow St"]);
  await db.query(prop, [ids.mixed, orgA, "6 Mixed St"]);
  await db.query(prop, [ids.otherOrg, orgB, "4 Other Org St"]);

  const ev = `insert into public.lead_events(org_id,property_id,actor_type,event_type,payload,created_at)
    values ($1,$2,'system',$3,$4::jsonb,$5::timestamptz)`;
  await db.query(ev, [orgA, ids.twice, "status_changed", '{"from":"new_lead","to":"interested"}', "2026-11-01T10:00:00Z"]);
  await db.query(ev, [orgA, ids.twice, "status_changed", '{"from":"interested","to":"follow_up"}', "2026-11-03T10:00:00Z"]);
  await db.query(ev, [orgA, ids.twice, "status_changed", '{"from":"follow_up","to":"interested"}', "2026-11-05T10:00:00Z"]);
  // A later event of another type with to=interested is not a move into Interested.
  await db.query(ev, [orgA, ids.twice, "note_added", '{"to":"interested"}', "2026-11-09T10:00:00Z"]);
  await db.query(ev, [orgA, ids.qualified, "qualified", '{"to":"interested"}', "2026-11-02T08:00:00Z"]);
  await db.query(ev, [orgA, ids.workflow, "my_leads_workflow", '{"operation":"ready_acquisition_offer"}', "2026-11-04T08:00:00Z"]);
  // Other workflow operations do not count.
  await db.query(ev, [orgA, ids.workflow, "my_leads_workflow", '{"operation":"snooze"}', "2026-11-06T08:00:00Z"]);
  await db.query(ev, [orgA, ids.never, "my_leads_workflow", '{"operation":"snooze"}', "2026-11-06T08:00:00Z"]);
  await db.query(ev, [orgA, ids.mixed, "status_changed", '{"from":"new_lead","to":"interested"}', "2026-11-01T07:00:00Z"]);
  await db.query(ev, [orgA, ids.mixed, "my_leads_workflow", '{"operation":"ready_acquisition_offer"}', "2026-11-07T07:00:00Z"]);
  await db.query(ev, [orgA, ids.never, "status_changed", '{"from":"new_lead","to":"follow_up"}', "2026-11-02T09:00:00Z"]);
  await db.query(ev, [orgB, ids.otherOrg, "status_changed", '{"from":"new_lead","to":"interested"}', "2026-11-02T12:00:00Z"]);
}

async function provisionSwitchboardRead() {
  // Mirrors the operator script's roles, schema and owner policies (see header).
  await db.query(`create role switchboard_read_owner nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls noreplication`);
  await db.query(`create role sandra_switchboard_reader login nosuperuser nocreatedb nocreaterole noinherit nobypassrls
    noreplication connection limit 3`);
  // Role names are explicit: GRANT/REVOKE ... CURRENT_USER segfaults the backend under some supautils builds.
  const me = (await db.query<{ me: string }>("select quote_ident(current_user) as me")).rows[0].me;
  await db.query(`grant switchboard_read_owner to ${me} with inherit true, set true`);
  // Test-only: lets this session SET ROLE to the reader (no inherit, so it gains none of the reader's rights).
  await db.query(`grant sandra_switchboard_reader to ${me} with inherit false, set true`);
  for (const table of ["properties", "contacts", "messages", "organizations"]) {
    const column = table === "organizations" ? "id" : "org_id";
    await db.query(`grant select on public.${table} to switchboard_read_owner`);
    await db.query(`create policy switchboard_read_owner_select on public.${table} for select to switchboard_read_owner
      using (${column} = '${orgA}'::uuid)`);
  }
  await db.query("create schema switchboard_read authorization switchboard_read_owner");
  await db.query("revoke all on schema switchboard_read from public");
  await db.query("grant usage on schema switchboard_read to sandra_switchboard_reader");
  // Stand-in for the existing interested_call_list view; this migration must not touch it.
  await db.query("set local role switchboard_read_owner");
  await db.query(`create view switchboard_read.interested_call_list with (security_barrier = true) as
    select p.id as property_id, p.org_id from public.properties p where p.org_id = '${orgA}'::uuid and p.status = 'interested'`);
  await db.query("reset role");
  await db.query("grant select on switchboard_read.interested_call_list to sandra_switchboard_reader");
}

beforeAll(async () => {
  db = new Client({ connectionString: url });
  await db.connect();
  const ready = await db.query(
    `select to_regclass('public.lead_events') is not null as ok,
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

describe("20261119120000 switchboard_read.norma_interested_since", () => {
  it("is a no-op on a database without switchboard_read", async () => {
    await db.query("savepoint noop");
    try {
      await db.query(migrationSql);
      const { rows } = await db.query("select to_regclass('switchboard_read.norma_interested_since') as v");
      expect(rows[0].v).toBeNull();
      const policy = await db.query(
        "select count(*)::int as n from pg_policies where tablename = 'lead_events' and policyname = 'switchboard_read_owner_select'",
      );
      expect(policy.rows[0].n).toBe(0);
    } finally {
      await db.query("rollback to savepoint noop");
    }
  });

  it("provisions on a switchboard_read database, is idempotent, and leaves interested_call_list and other policies alone", async () => {
    await seed();
    await provisionSwitchboardRead();
    const othersBefore = (await db.query(OTHER_STATE_SQL)).rows[0];
    await db.query(migrationSql);
    const before = (await db.query(STATE_SQL)).rows[0];
    await db.query(migrationSql); // re-run must succeed and change nothing
    const after = (await db.query(STATE_SQL)).rows[0];
    expect(after).toEqual(before);
    expect((await db.query(OTHER_STATE_SQL)).rows[0]).toEqual(othersBefore);

    const view = await db.query(
      `select c.relkind, pg_get_userbyid(c.relowner) as owner, c.reloptions
         from pg_class c where c.oid = 'switchboard_read.norma_interested_since'::regclass`,
    );
    expect(view.rows[0]).toEqual({ relkind: "v", owner: "switchboard_read_owner", reloptions: ["security_barrier=true"] });

    const policy = await db.query(
      `select roles::text[] as roles, cmd, qual from pg_policies
        where schemaname = 'public' and tablename = 'lead_events' and policyname = 'switchboard_read_owner_select'`,
    );
    expect(policy.rows).toEqual([{ roles: ["switchboard_read_owner"], cmd: "SELECT", qual: `(org_id = '${orgA}'::uuid)` }]);
  });

  it("view body is the Switchboard definition once the org literal is normalised", async () => {
    // Switchboard pins md5(pg_get_viewdef) for its production org; with a random test org the md5 differs, so compare the
    // definition with the org literal swapped back to a placeholder.
    const { rows } = await db.query<{ def: string }>(
      "select replace(pg_get_viewdef('switchboard_read.norma_interested_since'::regclass), $1, '<org>') as def",
      [orgA],
    );
    expect(rows[0].def).toBe(
      [
        " SELECT property_id,",
        "    max(created_at) AS interested_at",
        "   FROM lead_events e",
        "  WHERE ((org_id = '<org>'::uuid) AND (((event_type = 'status_changed'::text) AND ((payload ->> 'to'::text) = 'interested'::text)) OR ((event_type = 'my_leads_workflow'::text) AND ((payload ->> 'operation'::text) = 'ready_acquisition_offer'::text))))",
        "  GROUP BY property_id;",
      ].join("\n"),
    );
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
      const memberships = async () =>
        (await db.query(
          "select string_agg(format('%s|%s', member::regrole, grantor::regrole), ',') as m from pg_auth_members where roleid = 'switchboard_read_owner'::regrole",
        )).rows[0].m;
      const before = (await db.query(STATE_SQL)).rows[0];
      await db.query("set local role switchboard_read_owner");
      await db.query("drop view switchboard_read.norma_interested_since");
      await db.query("reset role");
      const me = (await db.query<{ me: string }>("select quote_ident(current_user) as me")).rows[0].me;
      await db.query(`revoke switchboard_read_owner from ${me} granted by ${me}`);
      expect(await has()).toEqual({ usage: false, set: false });
      const withoutSelfGrant = await memberships();

      await db.query(migrationSql);

      const after = (await db.query(STATE_SQL)).rows[0];
      expect({ ...after, memberships: null }).toEqual({ ...before, memberships: null });
      expect(await has()).toEqual({ usage: false, set: false });
      expect(await memberships()).toBe(withoutSelfGrant);
    } finally {
      await db.query("rollback to savepoint membership");
    }
  });

  it("matches the column contract exactly", async () => {
    const { rows } = await db.query<{ column_name: string; type: string }>(
      `select a.attname as column_name, format_type(a.atttypid, a.atttypmod) as type
         from pg_attribute a
        where a.attrelid = 'switchboard_read.norma_interested_since'::regclass and a.attnum > 0 and not a.attisdropped
        order by a.attnum`,
    );
    expect(rows.map((r) => [r.column_name, r.type])).toEqual(CONTRACT);
  });

  it("only the owner and the reader hold privileges on the view, and the reader may only SELECT", async () => {
    const { rows } = await db.query<{ grantee: string; privilege_type: string }>(
      `select grantee, privilege_type from information_schema.role_table_grants
        where table_schema = 'switchboard_read' and table_name = 'norma_interested_since' order by grantee, privilege_type`,
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

  it("the latest move into Interested wins, from either kind of event; other events give no row", async () => {
    const rows = await readerRows([ids.twice, ids.qualified, ids.never, ids.workflow, ids.mixed]);
    const byId = new Map(rows.map((r) => [r.property_id, r]));
    expect(byId.get(ids.twice)?.interested_at.toISOString()).toBe("2026-11-05T10:00:00.000Z");
    expect(byId.get(ids.workflow)?.interested_at.toISOString()).toBe("2026-11-04T08:00:00.000Z");
    expect(byId.get(ids.mixed)?.interested_at.toISOString()).toBe("2026-11-07T07:00:00.000Z");
    expect(byId.has(ids.qualified)).toBe(false);
    expect(byId.has(ids.never)).toBe(false);
    expect(rows).toHaveLength(3);
  });

  it("a status change into Interested after the workflow event wins", async () => {
    await db.query("savepoint later");
    try {
      await db.query(
        `insert into public.lead_events(org_id,property_id,actor_type,event_type,payload,created_at)
         values ($1,$2,'system','status_changed','{"to":"interested"}'::jsonb,'2026-11-08T07:00:00Z')`,
        [orgA, ids.mixed],
      );
      const [row] = await readerRows([ids.mixed]);
      expect(row.interested_at.toISOString()).toBe("2026-11-08T07:00:00.000Z");
    } finally {
      await db.query("rollback to savepoint later");
    }
  });

  it("another org's events are invisible", async () => {
    expect(await readerRows([ids.otherOrg])).toEqual([]);
    const props = await asReader(async () =>
      (await db.query("select property_id from switchboard_read.norma_interested_since")).rows.map((r) => r.property_id),
    );
    expect(props).not.toContain(ids.otherOrg);
  });

  it("the reader cannot write through the view or read lead_events directly", async () => {
    const probes = [
      "delete from switchboard_read.norma_interested_since",
      "select 1 from public.lead_events limit 1",
      "select 1 from public.properties limit 1",
      "insert into public.lead_events(org_id,property_id,actor_type,event_type) values (gen_random_uuid(),gen_random_uuid(),'system','x')",
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
      // 42501 = insufficient_privilege. A write through the grouped view may instead stop at 55000 (not auto-updatable).
      const refused = probe.includes("norma_interested_since") ? ["42501", "55000"] : ["42501"];
      expect([probe, refused.includes(code)]).toEqual([probe, true]);
    }
    const writable = await db.query(
      "select has_table_privilege('sandra_switchboard_reader', 'switchboard_read.norma_interested_since', 'INSERT, UPDATE, DELETE, TRUNCATE') as w",
    );
    expect(writable.rows[0].w).toBe(false);
  });
});
