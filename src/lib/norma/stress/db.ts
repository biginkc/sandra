import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client, type Pool } from "pg";

import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";

import { createStressPool } from "./pg-client";

/**
 * Scratch database for the Norma stress gate.
 *
 * The other Norma DB tests run inside one rolled-back transaction, which cannot
 * show a race. This gate needs real commits across many connections, so it
 * clones the schema of the local Supabase database (pg_dump | psql) into a
 * throw-away database, replays the Norma migrations there, installs audit
 * triggers, and drops it afterwards. The local `postgres` database is only
 * ever read from. Loopback only.
 */
const SOURCE_URL = requireLoopbackPostgresUrl(
  process.env.NORMA_STRESS_SOURCE_DB_URL ?? process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres",
);

const ALL_MIGRATIONS = [
  "20261002020000_norma_call_requests.sql",
  "20261002030000_norma_m2_hardening.sql",
  "20261002040000_norma_m2_review_fixes.sql",
  "20261002050000_norma_dnc_lock_task_writes.sql",
  "20261002060000_norma_create_request_serialize.sql",
  "20261002070000_norma_lock_order.sql",
];

// NORMA_STRESS_EXCLUDE_MIGRATIONS (comma-separated file names) leaves later fix
// migrations out, to prove a regression test fails without its fix.
const excluded = new Set((process.env.NORMA_STRESS_EXCLUDE_MIGRATIONS ?? "").split(",").map((x) => x.trim()).filter(Boolean));
const MIGRATIONS = ALL_MIGRATIONS.filter((m) => !excluded.has(m));

const withDb = (url: string, name: string) => {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
};

const AUDIT_SQL = `
create schema stress;

-- One row per committed change, written by trigger inside the same transaction,
-- so a rolled-back write leaves no trace and every real transition is recorded.
create table stress.audit (
  seq bigserial primary key,
  at timestamptz not null default clock_timestamp(),
  tbl text not null,
  op text not null,
  row_id uuid,
  property_id uuid,
  hold_open boolean,
  old_row jsonb,
  new_row jsonb
);

create function stress.audit_fn() returns trigger language plpgsql as $$
declare
  v_old jsonb := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
  v_new jsonb := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
  v_row jsonb := coalesce(v_new, v_old);
  v_prop uuid := coalesce(v_row ->> 'property_id', v_row ->> 'related_property_id')::uuid;
  v_hold boolean;
begin
  if tg_table_name = 'norma_notifications' then
    select r.property_id into v_prop from public.norma_call_requests r where r.id = (v_row ->> 'request_id')::uuid;
  end if;
  if tg_table_name = 'sequence_enrollments' and v_prop is not null then
    v_hold := public.fn_norma_hold_active(v_prop);
  end if;
  insert into stress.audit (tbl, op, row_id, property_id, hold_open, old_row, new_row)
  values (tg_table_name, tg_op, (v_row ->> 'id')::uuid, v_prop, v_hold, v_old, v_new);
  return null;
end $$;

create trigger stress_audit after insert or update or delete on public.norma_call_requests
  for each row execute function stress.audit_fn();
create trigger stress_audit after insert or update or delete on public.sequence_enrollments
  for each row execute function stress.audit_fn();
create trigger stress_audit after insert or update or delete on public.norma_notifications
  for each row execute function stress.audit_fn();
create trigger stress_audit after insert or update on public.tasks
  for each row when (new.source_key like 'norma_call:%')
  execute function stress.audit_fn();
create trigger stress_audit after insert on public.lead_events
  for each row execute function stress.audit_fn();
create trigger stress_audit after update on public.properties
  for each row when (old.outreach_dispo is distinct from new.outreach_dispo or old.is_dnc_locked is distinct from new.is_dnc_locked)
  execute function stress.audit_fn();

-- Injected database failure: while a row exists for a property, the matching
-- Norma write raises. Used to prove a failed completion rolls back everything.
create table stress.fault (property_id uuid primary key, tbl text not null);
create function stress.fault_fn() returns trigger language plpgsql as $$
declare v_prop uuid;
begin
  if tg_table_name = 'norma_notifications' then
    select r.property_id into v_prop from public.norma_call_requests r where r.id = new.request_id;
  else
    v_prop := new.related_property_id;
  end if;
  if exists (select 1 from stress.fault f where f.property_id = v_prop and f.tbl = tg_table_name) then
    raise exception 'stress: injected database failure on %', tg_table_name;
  end if;
  return new;
end $$;
-- Deterministic interleavings: a connection that sets stress.delay_request_ms (or
-- stress.delay_enrollment_ms) sleeps
-- inside its row update, AFTER the row is locked and before any later lock is
-- taken (named a_* so it fires before the other BEFORE UPDATE triggers).
create function stress.delay_fn() returns trigger language plpgsql as $$
declare v text := current_setting('stress.delay_' || tg_argv[0] || '_ms', true);
begin
  if coalesce(v, '') <> '' then perform pg_sleep(v::numeric / 1000.0); end if;
  return new;
end $$;
create trigger a_stress_delay before update on public.sequence_enrollments for each row execute function stress.delay_fn('enrollment');
create trigger a_stress_delay before update on public.norma_call_requests for each row execute function stress.delay_fn('request');
create trigger stress_fault before insert on public.norma_notifications for each row execute function stress.fault_fn();
create trigger stress_fault before insert on public.tasks for each row when (new.source_key like 'norma_call:%') execute function stress.fault_fn();
`;

export type Scratch = {
  url: string;
  name: string;
  pool: Pool;
  /** Move the database clock forward: every stored time moves back by `ms`. */
  advance: (ms: number) => Promise<void>;
  drop: () => Promise<void>;
};

export async function createScratchDb(): Promise<Scratch> {
  const name = `norma_stress_${process.pid}_${Date.now().toString(36)}`;
  const admin = new Client({ connectionString: SOURCE_URL });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();
  const url = withDb(SOURCE_URL, name);

  try {
    const dump = execFileSync("pg_dump", ["--schema-only", "--no-owner", SOURCE_URL], { maxBuffer: 256 * 1024 * 1024 });
    const restore = execFileSync("psql", ["-q", "-X", "-d", url], {
      input: dump,
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf8",
    }) as unknown as string;
    void restore;
  } catch (error) {
    // psql exits 0 even with SQL errors; a non-zero exit is a real failure.
    await dropDatabase(name);
    throw error;
  }

  const setup = new Client({ connectionString: url });
  await setup.connect();
  try {
    for (const file of MIGRATIONS) {
      await setup.query(readFileSync(path.join(process.cwd(), "supabase/migrations", file), "utf8"));
    }
    await setup.query(AUDIT_SQL);
  } catch (error) {
    await setup.end().catch(() => undefined);
    await dropDatabase(name);
    throw error;
  }
  await setup.end();

  const pool = createStressPool(url);
  const advance = async (ms: number) => {
    const iv = `${Math.floor(ms)} milliseconds`;
    // REPEATABLE READ: every table is shifted from ONE snapshot, so a request and
    // its task (written in one transaction) can never be shifted by different
    // amounts. A concurrent writer makes this fail with 40001; just retry.
    for (let attempt = 0; ; attempt += 1) {
      const c = await pool.connect();
      try {
        await c.query("begin isolation level repeatable read");
        // Triggers off for the shift only: it must not look like a state change.
        await c.query("set local session_replication_role = replica");
        await c.query(
          `update public.norma_call_requests set created_at = created_at - $1::interval, updated_at = updated_at - $1::interval,
             next_check_at = next_check_at - $1::interval, dispatch_started_at = dispatch_started_at - $1::interval,
             dispatched_at = dispatched_at - $1::interval, completed_at = completed_at - $1::interval,
             callback_requested_for = callback_requested_for - $1::interval`,
          [iv],
        );
        await c.query(
          `update public.norma_notifications set created_at = created_at - $1::interval, updated_at = updated_at - $1::interval,
             next_attempt_at = next_attempt_at - $1::interval`,
          [iv],
        );
        await c.query(
          `update public.norma_enrollment_pauses set created_at = created_at - $1::interval, released_at = released_at - $1::interval`,
          [iv],
        );
        await c.query(`update public.tasks set due_at = due_at - $1::interval where source_key like 'norma_call:%'`, [iv]);
        await c.query("commit");
        break;
      } catch (error) {
        await c.query("rollback").catch(() => undefined);
        const code = (error as { code?: string }).code;
        if ((code === "40001" || code === "40P01") && attempt < 50) continue;
        throw error;
      } finally {
        c.release();
      }
    }
    // The stale-call sweep is the only reader of enrollment times, and only of
    // call_in_progress pauses. They are shifted one row per statement: a bulk
    // update would hold many enrollment locks at once and could itself deadlock
    // with a multi-row worker, which is a harness artefact, not a Norma bug.
    const c = await pool.connect();
    try {
      await c.query("set session_replication_role = replica");
      const { rows } = await c.query<{ id: string }>(
        "select id from public.sequence_enrollments where status = 'paused' and pause_reason = 'call_in_progress' order by id",
      );
      for (const row of rows) {
        await c.query("update public.sequence_enrollments set updated_at = updated_at - $2::interval where id = $1 and status = 'paused' and pause_reason = 'call_in_progress'", [row.id, iv]);
      }
    } finally {
      await c.query("set session_replication_role = origin").catch(() => undefined);
      c.release();
    }
  };

  return {
    url,
    name,
    pool,
    advance,
    drop: async () => {
      await pool.end().catch(() => undefined);
      await dropDatabase(name);
    },
  };
}

async function dropDatabase(name: string) {
  const admin = new Client({ connectionString: SOURCE_URL });
  await admin.connect();
  try {
    await admin.query(`drop database if exists ${name} with (force)`);
  } finally {
    await admin.end();
  }
}

// ---------------------------------------------------------------------------
// World seeding
// ---------------------------------------------------------------------------

export type World = {
  org: string;
  rep1: string;
  rep2: string;
  assignee: string;
  sequences: string[];
  nextLead: (opts?: LeadOptions) => Promise<Lead>;
};
export type EnrollmentSeed = "active" | "paused:call_in_progress" | "paused:inbound_reply" | "paused:rep_sms_human_takeover";
export type LeadOptions = { enrollments?: EnrollmentSeed[]; dispo?: string | null; phone?: string };
export type Lead = { property: string; contact: string; phone: string; address: string; enrollments: string[] };

let leadCounter = 0;
let phoneCounter = 0;
/** Unique, valid, never-real US numbers (816-555-01xx style is too small; use 816-556-xxxx). */
export const nextPhone = () => `+1816556${String(1000 + (phoneCounter++ % 9000)).padStart(4, "0")}`;

export async function seedWorld(pool: Pool): Promise<World> {
  const org = randomUUID();
  const rep1 = randomUUID();
  const rep2 = randomUUID();
  const assignee = randomUUID();
  const sequences = [randomUUID(), randomUUID(), randomUUID()];
  await pool.query("insert into auth.users(id) values ($1), ($2), ($3)", [rep1, rep2, assignee]);
  await pool.query("insert into public.organizations(id, name) values ($1, 'norma stress')", [org]);
  await pool.query("insert into public.memberships(user_id, org_id, role, access_status) values ($1, $2, 'owner', 'active')", [assignee, org]);
  for (const rep of [rep1, rep2]) {
    await pool.query("insert into public.memberships(user_id, org_id, role, access_status) values ($1, $2, 'member', 'active')", [rep, org]);
  }
  for (const [i, id] of sequences.entries()) {
    await pool.query("insert into public.sequences(id, org_id, name) values ($1, $2, $3)", [id, org, `Drip ${i}`]);
    await pool.query("insert into public.sequence_steps(sequence_id, step_index, action_type, template_body) values ($1, 0, 'send_sms', 'hi')", [id]);
  }

  const nextLead = async (opts: LeadOptions = {}): Promise<Lead> => {
    const n = ++leadCounter;
    const property = randomUUID();
    const contact = randomUUID();
    const phone = opts.phone ?? nextPhone();
    const address = `${100000 + n} Stressgate Rd`;
    await pool.query("insert into public.contacts(id, org_id, first_name, phone_1, phone_1_type) values ($1, $2, 'Seller', $3, 'mobile')", [contact, org, phone]);
    await pool.query(
      "insert into public.properties(id, org_id, address, city, state, status, homeowner_contact_id, outreach_dispo) values ($1, $2, $3, 'Kansas City', 'MO', 'new_lead', $4, $5)",
      [property, org, address, contact, opts.dispo ?? null],
    );
    const enrollments: string[] = [];
    for (const [i, seed] of (opts.enrollments ?? ["active"]).entries()) {
      const paused = seed.startsWith("paused:");
      const id = (
        await pool.query<{ id: string }>(
          "insert into public.sequence_enrollments(org_id, sequence_id, property_id, contact_id, status, pause_reason, next_run_at) values ($1, $2, $3, $4, $5, $6, now()) returning id",
          [org, sequences[i % sequences.length], property, contact, paused ? "paused" : "active", paused ? seed.slice(7) : null],
        )
      ).rows[0]!.id;
      enrollments.push(id);
    }
    return { property, contact, phone, address, enrollments };
  };
  return { org, rep1, rep2, assignee, sequences, nextLead };
}
