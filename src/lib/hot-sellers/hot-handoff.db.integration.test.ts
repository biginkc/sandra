import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { LooseSupabase } from "@/app/(dashboard)/messages-v2/queries";
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
 * If the local database has no hold_alert_* tables, minimal copies are
 * created and dropped (same approach as store.integration.test.ts).
 */
const pg = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
const admin = createClient<Database>(process.env.TEST_SUPABASE_URL!, process.env.TEST_SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const loose = admin as unknown as LooseSupabase;

const created = { orgs: [] as string[], users: [] as string[] };
let createdDeliveries = false;
let createdSettings = false;

async function settle() {
  await pg.query("notify pgrst, 'reload schema'");
  await new Promise((r) => setTimeout(r, 1500));
}

beforeAll(async () => {
  assertLocalOnlyTestEnv(process.env.TEST_SUPABASE_DB_URL, process.env.TEST_SUPABASE_URL);
  await pg.connect();
  const deliveries = await pg.query("select to_regclass('public.hold_alert_deliveries') as t");
  if (!deliveries.rows[0].t) {
    await pg.query(`
      create table public.hold_alert_deliveries (
        id uuid primary key default gen_random_uuid(),
        org_id uuid not null references public.organizations(id) on delete cascade,
        property_id uuid references public.properties(id) on delete cascade,
        hold_key text not null,
        recipient_user_id uuid not null references auth.users(id) on delete cascade,
        channel text not null check (channel in ('slack', 'sms', 'email')),
        stage text not null check (stage in ('first', 'nudge_1h', 'digest')),
        status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed', 'skipped')),
        attempts integer not null default 0,
        last_error text,
        created_at timestamptz not null default now(),
        sent_at timestamptz,
        sending_at timestamptz,
        constraint hold_alert_deliveries_unique_key unique (hold_key, recipient_user_id, channel, stage)
      );
      grant select, insert, update on public.hold_alert_deliveries to service_role;
    `);
    createdDeliveries = true;
  }
  const settings = await pg.query("select to_regclass('public.hold_alert_settings') as t");
  if (!settings.rows[0].t) {
    await pg.query(`
      create table public.hold_alert_settings (
        org_id uuid primary key references public.organizations(id) on delete cascade,
        alerts_since timestamptz not null,
        created_at timestamptz not null default now()
      );
      grant select, insert, update on public.hold_alert_settings to service_role;
    `);
    createdSettings = true;
  }
  if (createdDeliveries || createdSettings) await settle();
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
    if (createdSettings) await pg.query("drop table if exists public.hold_alert_settings");
    if (createdDeliveries) await pg.query("drop table if exists public.hold_alert_deliveries");
    if (createdSettings || createdDeliveries) await pg.query("notify pgrst, 'reload schema'");
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

describe("assignHotLeadToOwner (real database)", () => {
  it("assigns an unassigned property to the single active owner with one ledger row and a My Leads episode", async () => {
    const { orgId, owner } = await oneOwnerOrg("assign");
    const propertyId = await createProperty(orgId);

    const result = await assignHotLeadToOwner(admin, propertyId, {});

    expect(result).toEqual({ status: "assigned", assigneeUserId: owner });
    expect(await assignedColumn(propertyId)).toBe(owner);
    const events = await handoffEvents(propertyId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_type: "assigned",
      source_type: HOT_HANDOFF_SOURCE_TYPE,
      source_id: propertyId,
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

    expect((await assignHotLeadToOwner(admin, propertyId, {})).status).toBe("assigned");
    const replay = await assignHotLeadToOwner(admin, propertyId, {});
    expect(replay).toEqual({ status: "already_assigned", assigneeUserId: owner });
    expect(await handoffEvents(propertyId)).toHaveLength(1);
    expect(await assignedColumn(propertyId)).toBe(owner);

    const racing = await createProperty(orgId);
    const [a, b] = await Promise.all([assignHotLeadToOwner(admin, racing, {}), assignHotLeadToOwner(admin, racing, {})]);
    expect([a.status, b.status].sort()).toEqual(["already_assigned", "assigned"]);
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

    const result = await assignHotLeadToOwner(admin, propertyId, {});

    expect(result).toEqual({ status: "failed", reason: "no_hot_owner" });
    expect(await assignedColumn(propertyId)).toBeNull();
    expect(await handoffEvents(propertyId)).toHaveLength(0);
  });

  it("fails closed with two active owners and no explicit pick, and writes nothing", async () => {
    const orgId = await createOrg("two-owners");
    const first = await createMember(orgId, "owner");
    await createMember(orgId, "owner");
    const propertyId = await createProperty(orgId);

    expect(await assignHotLeadToOwner(admin, propertyId, {})).toEqual({ status: "failed", reason: "no_hot_owner" });
    expect(await assignedColumn(propertyId)).toBeNull();
    expect(await handoffEvents(propertyId)).toHaveLength(0);

    // An explicit pick naming one of the active owners resolves the tie.
    const picked = await assignHotLeadToOwner(admin, propertyId, { env: { HOT_LEAD_ASSIGNEE_USER_ID: first } });
    expect(picked).toEqual({ status: "assigned", assigneeUserId: first });
  });

  it("never takes a lead already owned by another member", async () => {
    const { orgId } = await oneOwnerOrg("owned");
    const member = await createMember(orgId, "member");
    const propertyId = await createProperty(orgId, { assignedTo: member });

    const result = await assignHotLeadToOwner(admin, propertyId, {});

    expect(result).toEqual({ status: "failed", reason: "owned_by_someone_else" });
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

  it("interrupted hand-off (owner set, no events at all): back-fills the hand-off event and reports assigned", async () => {
    const { orgId, owner } = await oneOwnerOrg("interrupted");
    const propertyId = await createProperty(orgId, { assignedTo: owner });
    expect(await handoffEvents(propertyId)).toHaveLength(0);

    const inbound = randomUUID();
    const result = await assignHotLeadToOwner(admin, propertyId, { inboundMessageId: inbound });

    expect(result).toEqual({ status: "assigned", assigneeUserId: owner });
    const events = await handoffEvents(propertyId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ source_type: HOT_HANDOFF_SOURCE_TYPE, source_id: propertyId });
    expect(await hotTextEvents(propertyId)).toHaveLength(0);
    // A replay is now a plain already_assigned.
    expect(await assignHotLeadToOwner(admin, propertyId, { inboundMessageId: inbound })).toEqual({ status: "already_assigned", assigneeUserId: owner });
    expect(await handoffEvents(propertyId)).toHaveLength(1);
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

  it("a person-assigned lead with no inbound id cannot record the text: assigned_unrecorded, no event", async () => {
    const { orgId, owner } = await oneOwnerOrg("person-no-inbound");
    const propertyId = await createProperty(orgId, { assignedTo: owner });
    await personAssignedEvent(orgId, propertyId, owner);
    const result = await assignHotLeadToOwner(admin, propertyId, {});
    expect(result).toMatchObject({ status: "assigned_unrecorded", assigneeUserId: owner });
    expect(await hotTextEvents(propertyId)).toHaveLength(0);
  });

  it("the hand-off event cannot be recorded: assigned_unrecorded (the lead IS his), no event", async () => {
    const { orgId, owner } = await oneOwnerOrg("event-fail");
    const propertyId = await createProperty(orgId);
    // A trigger scoped to this one property makes its ledger insert fail; every other row is unaffected.
    const fn = `hot_handoff_block_${propertyId.replace(/-/g, "")}`;
    await pg.query(
      `create function public.${fn}() returns trigger language plpgsql as $$ begin raise exception 'blocked for test'; end $$`,
    );
    await pg.query(
      `create trigger ${fn} before insert on public.lead_events for each row when (new.property_id = '${propertyId}') execute function public.${fn}()`,
    );
    try {
      const result = await assignHotLeadToOwner(admin, propertyId, {});
      expect(result).toMatchObject({ status: "assigned_unrecorded", assigneeUserId: owner });
      expect(await assignedColumn(propertyId)).toBe(owner);
      expect(await handoffEvents(propertyId)).toHaveLength(0);
    } finally {
      await pg.query(`drop trigger if exists ${fn} on public.lead_events`);
      await pg.query(`drop function if exists public.${fn}()`);
    }
    // The column was written but the event was not. With no 'assigned' event naming him, a retry reads
    // that as Sandra's interrupted hand-off and finishes it (back-fill), instead of treating it as his already.
    const retry = await assignHotLeadToOwner(admin, propertyId, {});
    expect(retry).toEqual({ status: "assigned", assigneeUserId: owner });
    expect(await handoffEvents(propertyId)).toHaveLength(1);
  });

  it("refuses a DNC-locked property", async () => {
    const { orgId } = await oneOwnerOrg("dnc");
    const propertyId = await createProperty(orgId, { dnc: true });

    const result = await assignHotLeadToOwner(admin, propertyId, {});

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
    expect((await assignHotLeadToOwner(admin, propertyId, {})).status).toBe("assigned");

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
      expect(row.hold_key).toBe(`hot_promotion:${propertyId}`);
      expect(row.recipient_user_id).toBe(owner);
    }

    sent.length = 0;
    const second = await runHoldAlertsForOrg(deps, orgId);
    expect(second.sent).toBe(0);
    expect(sent).toHaveLength(0);
  });
});
