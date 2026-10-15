import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createHoldAlertDeps } from "@/lib/hold-alerts";
import { runHoldAlertsForOrg } from "@/lib/hold-alerts/core";
import type { HoldAlertDeps } from "@/lib/hold-alerts/types";
import type { Database } from "@/lib/supabase/types";
import { assertLocalOnlyTestEnv } from "@/lib/testing/local-only-test-env";

import { assignHotLeadToOwner, HOT_HANDOFF_SOURCE_TYPE, HOT_TEXT_SOURCE_TYPE } from "./assign";

/**
 * Hot-seller hand-off against the real local Postgres + PostgREST stack
 * (Messages v2 redesign, PR 2). Local only. Everything runs in temporary
 * organizations that this file creates and removes: the shared BMH org and
 * every other suite's rows are never touched, and tenant tables are never
 * reset.
 *
 * Scope note: the dispatch -> fn_auto_apply_jev_lead_decision leg is NOT
 * exercised here. That RPC (and jev_lead_decisions / pipeline_runs) is
 * absent from the shared local database, so the alert leg below starts from a
 * direct assignHotLeadToOwner call, which is exactly what dispatch.ts calls
 * right after the RPC succeeds.
 *
 * The hold_alert_* tables must exist (their migration); there is no fallback.
 */
const pg = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
const admin = createClient<Database>(process.env.TEST_SUPABASE_URL!, process.env.TEST_SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const created = { orgs: [] as string[], users: [] as string[] };

beforeAll(async () => {
  assertLocalOnlyTestEnv(process.env.TEST_SUPABASE_DB_URL, process.env.TEST_SUPABASE_URL);
  await pg.connect();
  // No fallback tables: a missing hold_alert_* migration must fail this suite.
  for (const table of ["hold_alert_deliveries", "hold_alert_settings"]) {
    const { rows } = await pg.query("select to_regclass($1) as t", [`public.${table}`]);
    expect(rows[0].t, `${table} must exist (migration missing)`).toBeTruthy();
  }
}, 60_000);

afterAll(async () => {
  try {
    for (const orgId of created.orgs) {
      // Temp-org rows only; triggers (final-owner guard, ledger guards) are bypassed for this transaction.
      try {
        await pg.query("begin");
        await pg.query("set local session_replication_role = replica");
        for (const table of [
          "hold_alert_deliveries",
          "hold_alert_settings",
          "acquisition_assignment_episodes",
          "acquisition_org_settings",
          "lead_events",
          "properties",
          "contacts",
          "memberships",
        ]) {
          await pg.query(`delete from public.${table} where org_id = $1`, [orgId]).catch(async (e) => {
            if (!/does not exist/.test(String(e?.message))) throw e;
            await pg.query("rollback");
            await pg.query("begin");
            await pg.query("set local session_replication_role = replica");
          });
        }
        await pg.query("delete from public.organizations where id = $1", [orgId]);
        await pg.query("commit");
      } catch {
        await pg.query("rollback").catch(() => undefined);
      }
    }
    if (created.users.length) {
      await pg.query("delete from auth.users where id = any($1::uuid[])", [created.users]).catch(() => undefined);
    }
  } finally {
    await pg.end();
  }
}, 60_000);

async function createOrg(label: string): Promise<string> {
  const id = randomUUID();
  const { error } = await admin.from("organizations").insert({ id, name: `hot-handoff ${label} ${id}` });
  if (error) throw new Error(`org insert failed: ${error.message}`);
  created.orgs.push(id);
  return id;
}

async function createMember(orgId: string, role: "owner" | "member"): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email: `hot-${randomUUID()}@test.local`,
    password: randomUUID(),
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`user create failed: ${error?.message}`);
  created.users.push(data.user.id);
  const { error: membershipError } = await admin
    .from("memberships")
    .insert({ user_id: data.user.id, org_id: orgId, role });
  if (membershipError) throw new Error(`membership insert failed: ${membershipError.message}`);
  return data.user.id;
}

async function createProperty(orgId: string, opts: { assignedTo?: string; dnc?: boolean } = {}) {
  const { data: contact, error: contactError } = await admin
    .from("contacts")
    .insert({ org_id: orgId, first_name: "Hannah", last_name: `Seller${randomUUID().slice(0, 6)}` })
    .select("id")
    .single();
  if (contactError || !contact) throw new Error(`contact insert failed: ${contactError?.message}`);
  const { data, error } = await admin
    .from("properties")
    .insert({
      org_id: orgId,
      address: `${Math.floor(Math.random() * 9000) + 100} Hot Handoff Ln`,
      state: "MO",
      status: "new_lead",
      homeowner_contact_id: contact.id,
      ...(opts.assignedTo ? { assigned_user_id: opts.assignedTo } : {}),
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`property insert failed: ${error?.message}`);
  if (opts.dnc) {
    const { error: dncError } = await admin.from("properties").update({ is_dnc_locked: true }).eq("id", data.id);
    if (dncError) throw new Error(`dnc lock failed: ${dncError.message}`);
  }
  return data.id;
}

async function assignedColumn(propertyId: string): Promise<string | null> {
  const { data, error } = await admin.from("properties").select("assigned_user_id").eq("id", propertyId).single();
  if (error || !data) throw new Error(`read failed: ${error?.message}`);
  return data.assigned_user_id;
}

async function handoffEvents(propertyId: string) {
  const { data, error } = await admin
    .from("lead_events")
    .select("event_type, source_type, source_id, payload")
    .eq("property_id", propertyId)
    .eq("event_type", "assigned");
  if (error) throw new Error(`events read failed: ${error.message}`);
  return data ?? [];
}

async function oneOwnerOrg(label: string) {
  const orgId = await createOrg(label);
  const owner = await createMember(orgId, "owner");
  // My Leads on for this temp org, with the owner designated, so the assignment trigger opens an eligible episode.
  await pg.query("insert into public.acquisition_org_settings (org_id, my_leads_enabled) values ($1, true)", [orgId]);
  // The designation guard wants its transaction-local marker ("<auth.uid()>:<org>:<user>"; uid is empty for the service role).
  await pg.query("begin");
  try {
    await pg.query("select set_config('my_leads.designation_update', $1, true)", [`:${orgId}:${owner}`]);
    await pg.query("update public.memberships set acquisitions_enabled = true where org_id = $1 and user_id = $2", [orgId, owner]);
    await pg.query("commit");
  } catch (error) {
    await pg.query("rollback");
    throw error;
  }
  return { orgId, owner };
}

async function insertInbound(orgId: string, propertyId: string): Promise<string> {
  const { data: prop } = await admin.from("properties").select("homeowner_contact_id").eq("id", propertyId).single();
  const { data, error } = await admin
    .from("messages")
    .insert({
      org_id: orgId, channel: "sms", direction: "inbound", status: "received", property_id: propertyId,
      contact_id: prop!.homeowner_contact_id, from_address: "+18165550177", to_address: "+18165550100", body: "make me an offer",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`inbound insert failed: ${error?.message}`);
  return data.id;
}

describe("assignHotLeadToOwner (real database)", () => {
  it("assigns an unassigned property to the single active owner with one ledger row and a My Leads episode", async () => {
    const { orgId, owner } = await oneOwnerOrg("assign");
    const propertyId = await createProperty(orgId);
    const inbound = await insertInbound(orgId, propertyId);

    const result = await assignHotLeadToOwner(admin, propertyId, { inboundMessageId: inbound });

    expect(result).toEqual({ status: "assigned", assigneeUserId: owner });
    expect(await assignedColumn(propertyId)).toBe(owner);
    const events = await handoffEvents(propertyId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_type: "assigned",
      source_type: HOT_HANDOFF_SOURCE_TYPE,
      source_id: inbound,
    });
    expect((events[0]!.payload as { to?: string }).to).toBe(owner);

    const { rows: episodes } = await pg.query(
      "select assignee_user_id, ended_at, eligible from public.acquisition_assignment_episodes where property_id = $1",
      [propertyId],
    );
    expect(episodes).toHaveLength(1);
    expect(episodes[0].assignee_user_id).toBe(owner);
    expect(episodes[0].ended_at).toBeNull();
    expect(episodes[0].eligible).toBe(true);
  });

  it("is idempotent: a replay and two concurrent calls leave one ledger row and the same assignee", async () => {
    const { orgId, owner } = await oneOwnerOrg("idempotent");
    const propertyId = await createProperty(orgId);

    const inbound = await insertInbound(orgId, propertyId);
    expect((await assignHotLeadToOwner(admin, propertyId, { inboundMessageId: inbound })).status).toBe("assigned");
    const replay = await assignHotLeadToOwner(admin, propertyId, { inboundMessageId: inbound });
    expect(replay).toEqual({ status: "already_assigned", assigneeUserId: owner });
    expect(await handoffEvents(propertyId)).toHaveLength(1);
    expect(await assignedColumn(propertyId)).toBe(owner);

    const racing = await createProperty(orgId);
    const racingInbound = await insertInbound(orgId, racing);
    const [a, b] = await Promise.all([
      assignHotLeadToOwner(admin, racing, { inboundMessageId: racingInbound }),
      assignHotLeadToOwner(admin, racing, { inboundMessageId: racingInbound }),
    ]);
    // One run wins the guarded update and writes the one 'assigned' event; the loser sees the owner already set
    // (lost race to the owner, not proven ours) and is treated as a hot text. Neither reassigns.
    for (const r of [a, b]) expect(["assigned", "already_assigned", "already_owned"]).toContain(r.status);
    expect([a, b].filter((r) => r.status === "assigned").length).toBe(1);
    expect(await handoffEvents(racing)).toHaveLength(1);
    expect(await assignedColumn(racing)).toBe(owner);
    const { rows } = await pg.query(
      "select count(*)::int as n from public.acquisition_assignment_episodes where property_id = $1 and ended_at is null",
      [racing],
    );
    expect(rows[0].n).toBe(1);
  });

  it("fails closed with no owner, and writes nothing", async () => {
    const orgId = await createOrg("no-owner");
    const lapsed = await createMember(orgId, "owner");
    await createMember(orgId, "member");
    // The only owner's access has lapsed, so the org has no ACTIVE owner.
    // The final-owner guard forbids this, so bypass triggers for this one transaction only (temp org rows).
    await pg.query("begin");
    try {
      await pg.query("set local session_replication_role = replica");
      await pg.query("update public.memberships set access_expires_at = now() - interval '1 day' where org_id = $1 and user_id = $2", [orgId, lapsed]);
      await pg.query("commit");
    } catch (error) {
      await pg.query("rollback");
      throw error;
    }
    const propertyId = await createProperty(orgId);
    const inbound = await insertInbound(orgId, propertyId);

    const result = await assignHotLeadToOwner(admin, propertyId, { inboundMessageId: inbound });

    expect(result).toEqual({ status: "failed", reason: "no_hot_owner" });
    expect(await assignedColumn(propertyId)).toBeNull();
    expect(await handoffEvents(propertyId)).toHaveLength(0);
  });

  it("fails closed with two active owners and no explicit pick, and writes nothing", async () => {
    const orgId = await createOrg("two-owners");
    const first = await createMember(orgId, "owner");
    await createMember(orgId, "owner");
    const propertyId = await createProperty(orgId);
    const inbound = await insertInbound(orgId, propertyId);

    expect(await assignHotLeadToOwner(admin, propertyId, { inboundMessageId: inbound })).toEqual({ status: "failed", reason: "no_hot_owner" });
    expect(await assignedColumn(propertyId)).toBeNull();
    expect(await handoffEvents(propertyId)).toHaveLength(0);

    // An explicit pick naming one of the active owners resolves the tie.
    const picked = await assignHotLeadToOwner(admin, propertyId, { inboundMessageId: inbound, env: { HOT_LEAD_ASSIGNEE_USER_ID: first } });
    expect(picked).toEqual({ status: "assigned", assigneeUserId: first });
  });

  it("never takes a lead already owned by another member", async () => {
    const { orgId } = await oneOwnerOrg("owned");
    const member = await createMember(orgId, "member");
    const propertyId = await createProperty(orgId, { assignedTo: member });
    const inbound = await insertInbound(orgId, propertyId);

    const result = await assignHotLeadToOwner(admin, propertyId, { inboundMessageId: inbound });

    expect(result).toEqual({ status: "owned_by_someone_else", ownerUserId: member });
    expect(await assignedColumn(propertyId)).toBe(member);
    expect(await handoffEvents(propertyId)).toHaveLength(0);
  });

  async function hotTextEvents(propertyId: string) {
    const { data, error } = await admin
      .from("lead_events")
      .select("event_type, source_type, source_id, payload")
      .eq("property_id", propertyId)
      .eq("source_type", HOT_TEXT_SOURCE_TYPE);
    if (error) throw new Error(`events read failed: ${error.message}`);
    return data ?? [];
  }
  async function personAssignedEvent(orgId: string, propertyId: string, to: string) {
    const { error } = await admin.from("lead_events").insert({
      org_id: orgId,
      property_id: propertyId,
      actor_type: "user",
      event_type: "assigned",
      payload: { from: null, to },
    } as never);
    if (error) throw new Error(`seed assigned event failed: ${error.message}`);
  }

  const allEventTypes = async (propertyId: string) => {
    const { data } = await admin.from("lead_events").select("event_type, source_type").eq("property_id", propertyId);
    return data ?? [];
  };

  /**
   * A rep wins the race: when Sandra's guarded update of this property runs, a rep is assigned first and her
   * update then matches no row (the trigger assigns the rep inside the same statement and skips her write).
   */
  async function repWinsRace(propertyId: string, rep: string) {
    const fn = `hot_race_${propertyId.replace(/-/g, "")}`;
    await pg.query(
      `create function public.${fn}() returns trigger language plpgsql as $$ begin
         if old.assigned_user_id is null and new.assigned_user_id is distinct from '${rep}' and new.assigned_user_id is not null then
           update public.properties set assigned_user_id = '${rep}' where id = '${propertyId}';
           return null;
         end if;
         return new; end $$`,
    );
    await pg.query(`create trigger ${fn} before update on public.properties for each row when (new.id = '${propertyId}') execute function public.${fn}()`);
    return async () => {
      await pg.query(`drop trigger if exists ${fn} on public.properties`);
      await pg.query(`drop function if exists public.${fn}()`);
    };
  }
  async function blockOn(table: "properties" | "lead_events", propertyId: string, op: string, cond: string) {
    const fn = `hot_block_${table}_${propertyId.replace(/-/g, "")}`;
    await pg.query(`create function public.${fn}() returns trigger language plpgsql as $$ begin raise exception 'blocked for test'; end $$`);
    await pg.query(`create trigger ${fn} before ${op} on public.${table} for each row when (${cond}) execute function public.${fn}()`);
    return async () => {
      await pg.query(`drop trigger if exists ${fn} on public.${table}`);
      await pg.query(`drop function if exists public.${fn}()`);
    };
  }
  const alertLoaderFor = async (orgId: string) => {
    const real = createHoldAlertDeps(admin, { HOLD_ALERTS_ENABLED: "1" });
    return (await real.loadHotPromotions(orgId, "2000-01-01T00:00:00.000Z")).promotions;
  };

  it("(a) the guarded update is blocked: failed, NO assigned event, column null, alert loader returns nothing", async () => {
    const { orgId } = await oneOwnerOrg("update-blocked");
    const propertyId = await createProperty(orgId);
    const inbound = await insertInbound(orgId, propertyId);
    const unblock = await blockOn("properties", propertyId, "update", `new.id = '${propertyId}'`);
    try {
      const result = await assignHotLeadToOwner(admin, propertyId, { inboundMessageId: inbound });
      expect(result.status).toBe("failed");
      expect(await assignedColumn(propertyId)).toBeNull();
      expect(await handoffEvents(propertyId)).toHaveLength(0);
      expect(await alertLoaderFor(orgId)).toEqual([]);
    } finally {
      await unblock();
    }
    // Block gone: the retry of the same inbound completes the hand-off.
    expect((await assignHotLeadToOwner(admin, propertyId, { inboundMessageId: inbound })).status).toBe("assigned");
    expect(await handoffEvents(propertyId)).toHaveLength(1);
  });

  it("a replay of a handed-off text reports who has the lead NOW and never fails: a rep -> owned_by_someone_else, nobody -> already_assigned (blank)", async () => {
    const { orgId, owner } = await oneOwnerOrg("replay-now");
    const rep = await createMember(orgId, "member");
    const propertyId = await createProperty(orgId);
    const inbound = await insertInbound(orgId, propertyId);
    expect((await assignHotLeadToOwner(admin, propertyId, { inboundMessageId: inbound })).status).toBe("assigned");
    // A person moves the lead to a rep; the same text is replayed.
    expect((await admin.from("properties").update({ assigned_user_id: rep }).eq("id", propertyId)).error).toBeNull();
    expect(await assignHotLeadToOwner(admin, propertyId, { inboundMessageId: inbound })).toEqual({ status: "owned_by_someone_else", ownerUserId: rep });
    // Unassigned since: the replay re-takes nothing and is not a failure.
    expect((await admin.from("properties").update({ assigned_user_id: null }).eq("id", propertyId)).error).toBeNull();
    expect(await assignHotLeadToOwner(admin, propertyId, { inboundMessageId: inbound })).toEqual({ status: "already_assigned", assigneeUserId: "" });
    expect(await assignedColumn(propertyId)).toBeNull();
    expect(await handoffEvents(propertyId)).toHaveLength(1);
    void owner;
  });

  it("(b) a rep wins the race: owned_by_someone_else, no assigned event; a later human assignment to Jarrad + a NEW inbound is already_owned (hot_text), never a hand-off", async () => {
    const { orgId, owner } = await oneOwnerOrg("race-lost");
    const rep = await createMember(orgId, "member");
    const propertyId = await createProperty(orgId);
    const inboundA = await insertInbound(orgId, propertyId);
    const unrace = await repWinsRace(propertyId, rep);
    try {
      const result = await assignHotLeadToOwner(admin, propertyId, { inboundMessageId: inboundA });
      expect(result).toEqual({ status: "owned_by_someone_else", ownerUserId: rep });
    } finally {
      await unrace();
    }
    expect(await assignedColumn(propertyId)).toBe(rep);
    expect(await handoffEvents(propertyId)).toHaveLength(0);
    expect(await hotTextEvents(propertyId)).toHaveLength(0);
    expect(await alertLoaderFor(orgId)).toEqual([]);

    // A person later gives it to Jarrad; a NEW hot inbound is a hot text, not a hand-off.
    const { error } = await admin.from("properties").update({ assigned_user_id: owner }).eq("id", propertyId);
    expect(error).toBeNull();
    const inboundB = await insertInbound(orgId, propertyId);
    expect(await assignHotLeadToOwner(admin, propertyId, { inboundMessageId: inboundB })).toEqual({ status: "already_owned", assigneeUserId: owner });
    expect(await handoffEvents(propertyId)).toHaveLength(0);
    expect(await hotTextEvents(propertyId)).toHaveLength(1);
    expect((await alertLoaderFor(orgId)).map((p) => p.kind)).toEqual(["hot_text"]);
  });

  it("(c) an OPEN HOT hold covers the hand-off: assigned with covered_by_hold:true, and the alert loader skips it (no second ping)", async () => {
    const { orgId, owner } = await oneOwnerOrg("covered");
    const propertyId = await createProperty(orgId);
    const inbound = await insertInbound(orgId, propertyId);
    // A flag time with a trailing-zero millisecond, so the key format is pinned every run.
    const flagAt = new Date(Math.floor(Date.now() / 1000) * 1000 + 120).toISOString();
    const { error } = await admin
      .from("properties")
      .update({ needs_human_attention: true, last_ai_escalation_reason: "model:hot_lead", last_ai_escalation_at: flagAt })
      .eq("id", propertyId);
    expect(error).toBeNull();
    // Covered means the hold actually pinged him: a sent delivery for its hot_flag key (flag time as the database stores it).
    // Read it back the way production does (PostgREST string, trailing zeros
    // trimmed), never rebuilt from a JS Date: ".120" is stored as ".12".
    const { data: storedRow, error: storedError } = await admin
      .from("properties")
      .select("last_ai_escalation_at")
      .eq("id", propertyId)
      .single();
    expect(storedError).toBeNull();
    const stored = storedRow!.last_ai_escalation_at as string;
    await pg.query(
      `insert into public.hold_alert_deliveries (org_id, property_id, hold_key, recipient_user_id, channel, stage, status, attempts, sent_at)
       values ($1, null, $2, $3, 'slack', 'first', 'sent', 1, now())`,
      [orgId, `hot_flag:${propertyId}:${stored}`, owner],
    );

    expect(await assignHotLeadToOwner(admin, propertyId, { inboundMessageId: inbound })).toEqual({ status: "assigned", assigneeUserId: owner });
    const events = await handoffEvents(propertyId);
    expect(events).toHaveLength(1);
    expect((events[0]!.payload as { covered_by_hold?: boolean }).covered_by_hold).toBe(true);
    expect(await alertLoaderFor(orgId)).toEqual([]);

    // A later hot text while the hold is open is covered too.
    const next = await insertInbound(orgId, propertyId);
    expect(await assignHotLeadToOwner(admin, propertyId, { inboundMessageId: next })).toEqual({ status: "already_owned", assigneeUserId: owner });
    expect((await hotTextEvents(propertyId))[0]!.payload).toMatchObject({ covered_by_hold: true });
    expect(await alertLoaderFor(orgId)).toEqual([]);
  });

  it("(d) the assigned-event write is blocked after the update: assigned_unrecorded, column set; a retry of the same inbound records a hot_text event (still one alert), never a second hand-off", async () => {
    const { orgId, owner } = await oneOwnerOrg("event-blocked-after");
    const propertyId = await createProperty(orgId);
    const inbound = await insertInbound(orgId, propertyId);
    const unblock = await blockOn("lead_events", propertyId, "insert", `new.property_id = '${propertyId}' and new.event_type = 'assigned'`);
    try {
      const result = await assignHotLeadToOwner(admin, propertyId, { inboundMessageId: inbound });
      expect(result).toMatchObject({ status: "assigned_unrecorded", assigneeUserId: owner });
      expect(await assignedColumn(propertyId)).toBe(owner);
      expect(await handoffEvents(propertyId)).toHaveLength(0);
      expect(await alertLoaderFor(orgId)).toEqual([]);
    } finally {
      await unblock();
    }
    const retry = await assignHotLeadToOwner(admin, propertyId, { inboundMessageId: inbound });
    expect(retry).toEqual({ status: "already_owned", assigneeUserId: owner });
    expect(await handoffEvents(propertyId)).toHaveLength(0);
    expect(await hotTextEvents(propertyId)).toHaveLength(1);
    expect((await alertLoaderFor(orgId)).map((p) => [p.kind, p.key])).toEqual([["hot_text", `hot_text:${inbound}`]]);
    expect((await assignHotLeadToOwner(admin, propertyId, { inboundMessageId: inbound })).status).toBe("already_owned");
    expect(await hotTextEvents(propertyId)).toHaveLength(1);
  });

  it("a lead Jarrad created himself (assigned at insert, only a lead_created event): already_owned, no 'assigned' event, one hot_text event", async () => {
    const { orgId, owner } = await oneOwnerOrg("self-created");
    const propertyId = await createProperty(orgId, { assignedTo: owner });
    const inbound = await insertInbound(orgId, propertyId);
    const types = (await allEventTypes(propertyId)).map((e) => e.event_type);
    expect(types).not.toContain("assigned");

    expect(await assignHotLeadToOwner(admin, propertyId, { inboundMessageId: inbound })).toEqual({ status: "already_owned", assigneeUserId: owner });
    expect(await handoffEvents(propertyId)).toHaveLength(0);
    expect(await hotTextEvents(propertyId)).toHaveLength(1);
  });

  it("housekeeping-style reassign BEFORE the inbound (direct column update, no lead_events): already_owned, never mistaken for an interrupted hand-off", async () => {
    const { orgId, owner } = await oneOwnerOrg("housekeeping");
    const other = await createMember(orgId, "member");
    const propertyId = await createProperty(orgId, { assignedTo: other });
    const { error } = await admin.from("properties").update({ assigned_user_id: owner }).eq("id", propertyId);
    expect(error).toBeNull();
    await new Promise((r) => setTimeout(r, 50));
    const inbound = await insertInbound(orgId, propertyId);

    expect(await assignHotLeadToOwner(admin, propertyId, { inboundMessageId: inbound })).toEqual({ status: "already_owned", assigneeUserId: owner });
    expect(await handoffEvents(propertyId)).toHaveLength(0);
    expect(await hotTextEvents(propertyId)).toHaveLength(1);
  });

  it("completed hand-off with inbound A, then hot inbound B: already_owned + one hot_seller_text; B again: nothing new; A again: already_assigned", async () => {
    const { orgId, owner } = await oneOwnerOrg("second-inbound");
    const propertyId = await createProperty(orgId);
    const a = await insertInbound(orgId, propertyId);
    expect(await assignHotLeadToOwner(admin, propertyId, { inboundMessageId: a })).toEqual({ status: "assigned", assigneeUserId: owner });
    const b = await insertInbound(orgId, propertyId);

    expect(await assignHotLeadToOwner(admin, propertyId, { inboundMessageId: b })).toEqual({ status: "already_owned", assigneeUserId: owner });
    let texts = await hotTextEvents(propertyId);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatchObject({ source_id: b, event_type: "ai_escalated" });

    expect((await assignHotLeadToOwner(admin, propertyId, { inboundMessageId: b })).status).toBe("already_owned");
    expect(await hotTextEvents(propertyId)).toHaveLength(1);

    expect(await assignHotLeadToOwner(admin, propertyId, { inboundMessageId: a })).toEqual({ status: "already_assigned", assigneeUserId: owner });
    texts = await hotTextEvents(propertyId);
    expect(texts).toHaveLength(1);
    expect(await handoffEvents(propertyId)).toHaveLength(1);
    expect(await assignedColumn(propertyId)).toBe(owner);
  });

  it("a person already assigned him the lead: already_owned, one hot_seller_text event per inbound, no reassignment, no new 'assigned' event", async () => {
    const { orgId, owner } = await oneOwnerOrg("person-assigned");
    const propertyId = await createProperty(orgId, { assignedTo: owner });
    await personAssignedEvent(orgId, propertyId, owner);
    const before = await handoffEvents(propertyId);
    expect(before).toHaveLength(1);

    const inboundA = randomUUID();
    expect(await assignHotLeadToOwner(admin, propertyId, { inboundMessageId: inboundA })).toEqual({ status: "already_owned", assigneeUserId: owner });
    expect(await assignedColumn(propertyId)).toBe(owner);
    let texts = await hotTextEvents(propertyId);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatchObject({ event_type: "ai_escalated", source_type: HOT_TEXT_SOURCE_TYPE, source_id: inboundA });

    // Replay with the same inbound: no second event.
    expect((await assignHotLeadToOwner(admin, propertyId, { inboundMessageId: inboundA })).status).toBe("already_owned");
    expect(await hotTextEvents(propertyId)).toHaveLength(1);

    // A different inbound is a new hot decision: a second event.
    const inboundB = randomUUID();
    expect((await assignHotLeadToOwner(admin, propertyId, { inboundMessageId: inboundB })).status).toBe("already_owned");
    texts = await hotTextEvents(propertyId);
    expect(texts.map((t) => t.source_id).sort()).toEqual([inboundA, inboundB].sort());

    // Never a new 'assigned' event or a hand-off event.
    expect(await handoffEvents(propertyId)).toHaveLength(1);
    expect((await handoffEvents(propertyId))[0]!.source_type).toBeNull();
  });

  it("no inbound id at all: failed, nothing assigned, no event of any kind", async () => {
    const { orgId, owner } = await oneOwnerOrg("person-no-inbound");
    const propertyId = await createProperty(orgId, { assignedTo: owner });
    await personAssignedEvent(orgId, propertyId, owner);
    const result = await assignHotLeadToOwner(admin, propertyId, {});
    expect(result).toMatchObject({ status: "failed", reason: "db_error" });
    expect(await hotTextEvents(propertyId)).toHaveLength(0);
    const fresh = await createProperty(orgId);
    expect(await assignHotLeadToOwner(admin, fresh, {})).toMatchObject({ status: "failed" });
    expect(await assignedColumn(fresh)).toBeNull();
  });

  it("every ledger write for the property fails: no event, and the call never reports a recorded hand-off", async () => {
    const { orgId } = await oneOwnerOrg("event-fail");
    const propertyId = await createProperty(orgId);
    const inbound = await insertInbound(orgId, propertyId);
    const fn = `hot_handoff_block_${propertyId.replace(/-/g, "")}`;
    await pg.query(
      `create function public.${fn}() returns trigger language plpgsql as $$ begin raise exception 'blocked for test'; end $$`,
    );
    await pg.query(
      `create trigger ${fn} before insert on public.lead_events for each row when (new.property_id = '${propertyId}') execute function public.${fn}()`,
    );
    try {
      const result = await assignHotLeadToOwner(admin, propertyId, { inboundMessageId: inbound });
      expect(["failed", "assigned_unrecorded"]).toContain(result.status);
      expect(result.status).not.toBe("assigned");
      expect(await handoffEvents(propertyId)).toHaveLength(0);
      expect(await alertLoaderFor(orgId)).toEqual([]);
    } finally {
      await pg.query(`drop trigger if exists ${fn} on public.lead_events`);
      await pg.query(`drop function if exists public.${fn}()`);
    }
  });

  it("refuses a DNC-locked property", async () => {
    const { orgId } = await oneOwnerOrg("dnc");
    const propertyId = await createProperty(orgId, { dnc: true });
    const inbound = await insertInbound(orgId, propertyId);

    const result = await assignHotLeadToOwner(admin, propertyId, { inboundMessageId: inbound });

    expect(result).toEqual({ status: "failed", reason: "dnc_locked" });
    expect(await assignedColumn(propertyId)).toBeNull();
    expect(await handoffEvents(propertyId)).toHaveLength(0);
  });
});

describe("hot promotion alert pass after the hand-off (real database, recording senders)", () => {
  it("sends exactly one Slack and one SMS to the owner, records both as sent, and sends nothing on a second pass", async () => {
    const { orgId, owner } = await oneOwnerOrg("alerts");
    await createMember(orgId, "member"); // a non-owner must never be pinged
    // Alerts were enabled before the promotion.
    const watermark = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { error: seedError } = await admin
      .from("hold_alert_settings" as never)
      .insert({ org_id: orgId, alerts_since: watermark } as never);
    expect(seedError).toBeNull();
    const propertyId = await createProperty(orgId);
    const inbound = await insertInbound(orgId, propertyId);
    expect((await assignHotLeadToOwner(admin, propertyId, { inboundMessageId: inbound })).status).toBe("assigned");

    const sent: Array<{ channel: "slack" | "sms"; userId: string; text: string }> = [];
    const real = createHoldAlertDeps(admin, { HOLD_ALERTS_ENABLED: "1" });
    const deps: HoldAlertDeps = {
      ...real,
      // The page-hold loaders read tables this shared local database lacks; this test is about
      // hot promotions only, which keep their real loader, owner lookup and recipient checks.
      loadHolds: async () => ({ holds: [], complete: true }),
      loadHeldPropertyIds: async () => new Set<string>() as never,
      async sendSlack(userId, text) {
        sent.push({ channel: "slack", userId, text });
        return { status: "sent" };
      },
      async sendSms(userId, text) {
        sent.push({ channel: "sms", userId, text });
        return { status: "sent" };
      },
    };

    const first = await runHoldAlertsForOrg(deps, orgId);
    expect(first.sent).toBe(2);
    expect(sent.map((s) => s.channel).sort()).toEqual(["slack", "sms"]);
    expect(sent.every((s) => s.userId === owner)).toBe(true);

    const { rows } = await pg.query(
      "select channel, status, property_id, hold_key, recipient_user_id from public.hold_alert_deliveries where org_id = $1 order by channel",
      [orgId],
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe("sent");
      expect(row.property_id).toBeNull();
      expect(row.hold_key).toBe(`hot_handoff:${inbound}`);
      expect(row.recipient_user_id).toBe(owner);
    }

    sent.length = 0;
    const second = await runHoldAlertsForOrg(deps, orgId);
    expect(second.sent).toBe(0);
    expect(sent).toHaveLength(0);
  });
});
