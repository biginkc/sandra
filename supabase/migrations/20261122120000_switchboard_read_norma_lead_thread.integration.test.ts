import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { requireLoopbackPostgresUrl } from "../../src/lib/testing/loopback-postgres-url";

/**
 * switchboard_read.norma_lead_thread (20261122120000).
 *
 * Runs on a disposable loopback database with the full migration chain applied, inside one transaction that is always
 * rolled back. switchboard_read itself is provisioned by Switchboard's operator script (Switchboard repo,
 * db/sandra/0001_switchboard_read.sql), so the fixture below recreates the parts of it this view depends on: the two
 * roles, the schema, the org-scoped owner policies on properties/contacts/messages/organizations, and an
 * interested_call_list stand-in (to prove this migration leaves existing views alone). Then it runs this migration and
 * reads the view as sandra_switchboard_reader. Every message body is synthetic.
 */
const url = requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL ?? "");
const migrationSql = readFileSync(path.resolve(__dirname, "20261122120000_switchboard_read_norma_lead_thread.sql"), "utf8");

const CONTRACT: [string, string][] = [
  ["property_id", "uuid"],
  ["message_id", "uuid"],
  ["direction", "text"],
  ["body", "text"],
  ["at", "timestamp with time zone"],
];

const orgA = randomUUID();
const orgB = randomUUID();
const ids = {
  thread: randomUUID(), // org A, a mixed thread
  quiet: randomUUID(), // org A, only never-sent outbound texts
  otherOrg: randomUUID(), // org B
};

let db: Client;

type PlanNode = { "Node Type": string; "Relation Name"?: string; "Index Name"?: string; "Index Cond"?: string; "Recheck Cond"?: string; Plans?: PlanNode[] };

const STATE_SQL = `select
    (select pg_get_viewdef('switchboard_read.norma_lead_thread'::regclass)) as viewdef,
    (select row(c.relowner::regrole::text, c.relacl::text, c.reloptions::text)::text from pg_class c
      where c.oid = 'switchboard_read.norma_lead_thread'::regclass) as view_meta,
    (select relacl::text from pg_class where oid = 'public.messages'::regclass) as messages_acl,
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
       from pg_policies) as all_policies,
    (select string_agg(format('%s|%s', relname, relacl), ',' order by relname) from pg_class
      where relnamespace = 'public'::regnamespace and relkind in ('r', 'p', 'v', 'm')) as public_acls`;

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
    (await db.query(
      "select * from switchboard_read.norma_lead_thread where property_id = any($1::uuid[]) order by at, message_id",
      [propertyIds],
    )).rows,
  );
}

const MSG = `insert into public.messages(org_id,property_id,channel,direction,status,body,created_at,sent_at)
  values ($1,$2,$3,$4,$5,$6,$7::timestamptz,$8::timestamptz)`;

async function seed() {
  await db.query("insert into public.organizations(id,name) values ($1,'NLT A'),($2,'NLT B')", [orgA, orgB]);
  const prop = "insert into public.properties(id,org_id,address,state,status) values ($1,$2,$3,'MO','interested')";
  await db.query(prop, [ids.thread, orgA, "1 Thread St"]);
  await db.query(prop, [ids.quiet, orgA, "2 Quiet St"]);
  await db.query(prop, [ids.otherOrg, orgB, "3 Other Org St"]);
  // Created early, sent later: timed by when it went out.
  await db.query(MSG, [orgA, ids.thread, "sms", "outbound", "delivered", "Synthetic out one", "2026-11-20T09:00:00Z", "2026-11-20T09:30:00Z"]);
  await db.query(MSG, [orgA, ids.thread, "sms", "inbound", "received", "Synthetic in one", "2026-11-20T09:45:00Z", null]);
  // Sent with no sent_at: timed by created_at.
  await db.query(MSG, [orgA, ids.thread, "sms", "outbound", "sent", "Synthetic out two", "2026-11-20T10:00:00Z", null]);
  for (const status of ["pending", "queued", "failed", "bounced"]) {
    await db.query(MSG, [orgA, ids.thread, "sms", "outbound", status, `Synthetic never sent ${status}`, "2026-11-20T11:00:00Z", null]);
    await db.query(MSG, [orgA, ids.quiet, "sms", "outbound", status, `Synthetic never sent ${status}`, "2026-11-20T11:00:00Z", null]);
  }
  await db.query(MSG, [orgA, ids.thread, "email", "outbound", "delivered", "Synthetic email", "2026-11-20T12:00:00Z", "2026-11-20T12:00:00Z"]);
  await db.query(MSG, [orgA, null, "sms", "inbound", "received", "Synthetic no property", "2026-11-20T12:00:00Z", null]);
  await db.query(MSG, [orgB, ids.otherOrg, "sms", "inbound", "received", "Synthetic other org", "2026-11-20T12:00:00Z", null]);
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
    `select to_regclass('public.messages') is not null and to_regclass('public.idx_messages_property_created_id') is not null as ok,
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

describe("20261122120000 switchboard_read.norma_lead_thread", () => {
  it("is a no-op on a database without switchboard_read", async () => {
    await db.query("savepoint noop");
    try {
      await db.query(migrationSql);
      const { rows } = await db.query("select to_regclass('switchboard_read.norma_lead_thread') as v");
      expect(rows[0].v).toBeNull();
    } finally {
      await db.query("rollback to savepoint noop");
    }
  });

  it("provisions on a switchboard_read database, is idempotent, and changes no policy, base-table grant or other view", async () => {
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
         from pg_class c where c.oid = 'switchboard_read.norma_lead_thread'::regclass`,
    );
    expect(view.rows[0]).toEqual({ relkind: "v", owner: "switchboard_read_owner", reloptions: ["security_barrier=true"] });
  });

  it("view body is the Switchboard definition once the org literal is normalised", async () => {
    // Switchboard pins md5(pg_get_viewdef) = 7c6478db249688463327b73da6a75152, computed with the production org id, which
    // the operator passes at run time; with a random test org the md5 differs, so compare with the org swapped back.
    const { rows } = await db.query<{ def: string }>(
      "select replace(pg_get_viewdef('switchboard_read.norma_lead_thread'::regclass), $1, '<org>') as def",
      [orgA],
    );
    expect(rows[0].def).toBe(
      [
        " SELECT property_id,",
        "    id AS message_id,",
        "    direction,",
        "    body,",
        "        CASE",
        "            WHEN (direction = 'outbound'::text) THEN COALESCE(sent_at, created_at)",
        "            ELSE created_at",
        "        END AS at",
        "   FROM messages m",
        "  WHERE ((org_id = '<org>'::uuid) AND (property_id IS NOT NULL) AND (channel = 'sms'::text) AND ((direction = 'inbound'::text) OR ((direction = 'outbound'::text) AND (status = ANY (ARRAY['sent'::text, 'delivered'::text])))));",
      ].join("\n"),
    );
  });

  it("re-running Switchboard's statements after this migration changes nothing", async () => {
    // Copied verbatim from Switchboard db/sandra/0001_switchboard_read.sql (biginkc/Switchboard branch claude/norma-seller-threads):
    // the view statement, the owner change and the reader grant.
    const switchboard = `do $sb$
declare
  v_org uuid := '${orgA}';
begin
  execute format($view$
    create or replace view switchboard_read.norma_lead_thread with (security_barrier = true) as
    select m.property_id::uuid as property_id,
           m.id::uuid as message_id,
           m.direction::text as direction,
           m.body::text as body,
           (case when m.direction = 'outbound' then coalesce(m.sent_at, m.created_at) else m.created_at end)::timestamptz as at
      from public.messages m
     where m.org_id = %1$L::uuid
       and m.property_id is not null
       and m.channel = 'sms'
       and (m.direction = 'inbound' or (m.direction = 'outbound' and m.status in ('sent', 'delivered')))
  $view$, v_org);
  alter view switchboard_read.norma_lead_thread owner to switchboard_read_owner;
  grant select on switchboard_read.norma_lead_thread to sandra_switchboard_reader;
end
$sb$`;
    const md5Sql = "select md5(pg_get_viewdef('switchboard_read.norma_lead_thread'::regclass)) as m";
    await db.query("savepoint sb");
    try {
      const before = (await db.query(STATE_SQL)).rows[0];
      const md5Before = (await db.query(md5Sql)).rows[0].m;
      await db.query(switchboard);
      expect((await db.query(md5Sql)).rows[0].m).toBe(md5Before);
      expect((await db.query(STATE_SQL)).rows[0]).toEqual(before);
    } finally {
      await db.query("rollback to savepoint sb");
    }
  });

  it("refuses to run when the owner policies disagree on the org", async () => {
    await db.query("savepoint mismatch");
    try {
      await db.query(`alter policy switchboard_read_owner_select on public.messages using (org_id = '${orgB}'::uuid)`);
      await expect(db.query(migrationSql)).rejects.toThrow(
        `switchboard_read_owner_select on public.messages does not scope to org ${orgA}`,
      );
    } finally {
      await db.query("rollback to savepoint mismatch");
    }
  });

  it("refuses to run (and grants nothing) when the owner cannot read public.messages", async () => {
    await db.query("savepoint nomessages");
    try {
      await db.query("revoke select on public.messages from switchboard_read_owner");
      await expect(db.query(migrationSql)).rejects.toThrow("switchboard_read_owner cannot read public.messages");
    } finally {
      await db.query("rollback to savepoint nomessages");
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
      await db.query("drop view switchboard_read.norma_lead_thread");
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
        where a.attrelid = 'switchboard_read.norma_lead_thread'::regclass and a.attnum > 0 and not a.attisdropped
        order by a.attnum`,
    );
    expect(rows.map((r) => [r.column_name, r.type])).toEqual(CONTRACT);
  });

  it("only the owner and the reader hold privileges on the view, and the reader may only SELECT", async () => {
    const { rows } = await db.query<{ grantee: string; privilege_type: string }>(
      `select grantee, privilege_type from information_schema.role_table_grants
        where table_schema = 'switchboard_read' and table_name = 'norma_lead_thread' order by grantee, privilege_type`,
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

  it("inbound texts plus outbound texts that went out, timed by when they went out; never-sent, email and unlinked rows excluded", async () => {
    const rows = await readerRows([ids.thread, ids.quiet]);
    expect(rows.map((r) => [r.property_id, r.direction, r.body, r.at.toISOString()])).toEqual([
      [ids.thread, "outbound", "Synthetic out one", "2026-11-20T09:30:00.000Z"],
      [ids.thread, "inbound", "Synthetic in one", "2026-11-20T09:45:00.000Z"],
      [ids.thread, "outbound", "Synthetic out two", "2026-11-20T10:00:00.000Z"],
    ]);
    expect(rows.every((r) => typeof r.message_id === "string")).toBe(true);
  });

  it("another org's texts are invisible", async () => {
    expect(await readerRows([ids.otherOrg])).toEqual([]);
    const bodies = await asReader(async () =>
      (await db.query("select body from switchboard_read.norma_lead_thread")).rows.map((r) => r.body),
    );
    expect(bodies).not.toContain("Synthetic other org");
  });

  it("the reader cannot write through the view or read messages directly", async () => {
    const probes = [
      "delete from switchboard_read.norma_lead_thread",
      "update switchboard_read.norma_lead_thread set body = 'x'",
      "select 1 from public.messages limit 1",
      "select 1 from public.properties limit 1",
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
      expect([probe, code]).toEqual([probe, "42501"]);
    }
  });

  it("a property_id lookup is an index scan on messages keyed by property_id", async () => {
    await db.query("savepoint plan");
    try {
      await db.query(
        `with p as (
           insert into public.properties(org_id,address,state,status)
           select $1, 'Bulk ' || g, 'MO', 'new_lead' from generate_series(1, 300) g returning id)
         insert into public.messages(org_id,property_id,channel,direction,status,body,created_at)
         select $1, p.id, 'sms', d, case d when 'inbound' then 'received' else 'delivered' end, 'Synthetic bulk',
                now() - make_interval(mins => g)
           from p, generate_series(1, 8) g, unnest(array['inbound','outbound']) d`,
        [orgA],
      );
      await db.query("analyze public.properties, public.messages");
      const plan = await asReader(async () => {
        const { rows } = await db.query(
          "explain (format json) select direction, body, at from switchboard_read.norma_lead_thread where property_id = $1::uuid order by at desc limit 201",
          [ids.thread],
        );
        return rows[0]["QUERY PLAN"][0].Plan as PlanNode;
      });
      const nodes: PlanNode[] = [];
      const walk = (node: PlanNode) => {
        if (node["Relation Name"]) nodes.push(node);
        for (const child of node.Plans ?? []) walk(child);
      };
      walk(plan);
      const messages = nodes.filter((n) => n["Relation Name"] === "messages");
      expect(messages.length).toBeGreaterThanOrEqual(1);
      for (const node of messages) {
        expect(node["Node Type"]).not.toBe("Seq Scan");
        expect(node["Index Cond"] ?? node["Recheck Cond"] ?? "").toMatch(/property_id = /);
      }
    } finally {
      await db.query("rollback to savepoint plan");
    }
  });
});
