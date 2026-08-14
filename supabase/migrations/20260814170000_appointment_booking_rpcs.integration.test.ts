import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { loadTestEnv } from "@tests/integration/env";
import { resetTenantTables } from "@tests/integration/reset";
import {
  BMH_ORG_ID,
  TEST_ORG_B_ID,
  clientForUser,
  createOrgUser,
  seedTwoOrgs,
} from "@tests/integration/fixtures/multi-user";
import type { Database } from "@/lib/supabase/types";

/**
 * Raw Postgres connection string for the two-connection concurrent-replay
 * idempotency test below. Same lookup/rationale as
 * 20260814150000_appointments_schema.integration.test.ts's `testDbUrl` —
 * `TEST_SUPABASE_DB_URL` isn't forwarded into worker `process.env`, so any
 * file needing a raw connection loads `.env.test.local` itself.
 */
function testDbUrl(): string {
  const env = loadTestEnv();
  const url = process.env.TEST_SUPABASE_DB_URL ?? env.TEST_SUPABASE_DB_URL;
  if (!url) {
    throw new Error(
      "Missing TEST_SUPABASE_DB_URL in .env.test.local — see tests/integration/README.md.",
    );
  }
  return url;
}

// ----------------------------------------------------------------------------
// fn_book_appointment / fn_get_member_timezone are not (and, per this PR's
// scope, must not be) added to the generated Database["public"]["Functions"]
// map — that regeneration belongs to whichever PR promotes the RPC into
// application call sites. These local, hand-written signatures give the
// test full type safety against the SQL contract without touching
// src/lib/supabase/types.ts, mirroring the existing local-cast pattern in
// src/lib/auth/require-org-membership.ts (MembershipLookupClient /
// ResourceLookupClient).
// ----------------------------------------------------------------------------
type BookAppointmentArgs = {
  p_org: string;
  p_assignee: string;
  p_start: string;
  p_end: string;
  p_timezone: string;
  p_title: string;
  p_contact?: string | null;
  p_property?: string | null;
  p_description?: string | null;
  p_idempotency_key?: string | null;
};

type BookAppointmentRow = {
  task_id: string;
  calendar_chain_id: string;
  already_qualified: boolean;
  duplicate: boolean;
  /** Round 9: the persisted task's linkage, always echoed back so callers
   *  derive post-booking effects from what was actually booked/matched,
   *  never from the request. */
  related_property_id: string | null;
  contact_id: string | null;
};

type RpcResult<T> = {
  data: T | null;
  error: { message: string; code?: string } | null;
};

type BookingRpcClient = {
  rpc(
    fn: "fn_book_appointment",
    args: BookAppointmentArgs,
  ): Promise<RpcResult<BookAppointmentRow>>;
  rpc(
    fn: "fn_get_member_timezone",
    args: { p_user: string },
  ): Promise<RpcResult<string>>;
};

function asBookingRpcClient(client: SupabaseClient<Database>): BookingRpcClient {
  return client as unknown as BookingRpcClient;
}

function bookAppointment(
  client: SupabaseClient<Database>,
  args: BookAppointmentArgs,
): Promise<RpcResult<BookAppointmentRow>> {
  return asBookingRpcClient(client).rpc("fn_book_appointment", args);
}

// booking_idempotency_key is a column this migration adds; like the two
// functions above, it isn't (and per this PR's scope, must not be) in the
// generated Database["public"]["Tables"]["tasks"]["Row"] type yet — same
// local-cast pattern.
type IdempotencyTaskRow = { id: string; title: string };
function tasksByIdempotencyKey(
  key: string,
): Promise<{ data: IdempotencyTaskRow[] | null; error: { message: string } | null }> {
  const reader = db as unknown as {
    from(table: "tasks"): {
      select(columns: string): {
        eq(
          column: "booking_idempotency_key",
          value: string,
        ): Promise<{
          data: IdempotencyTaskRow[] | null;
          error: { message: string } | null;
        }>;
      };
    };
  };
  return reader.from("tasks").select("id, title").eq("booking_idempotency_key", key);
}

function getMemberTimezone(
  client: SupabaseClient<Database>,
  userId: string,
): Promise<RpcResult<string>> {
  return asBookingRpcClient(client).rpc("fn_get_member_timezone", { p_user: userId });
}

// fn_claim_calendar_creations / fn_expire_exhausted_calendar_creations are
// the PR-2 pull-forward of PR 3's ledger consumer — same local-cast
// rationale as the booking RPCs above.
type ClaimCalendarCreationsRow = {
  ledger_id: string;
  org_id: string;
  calendar_chain_id: string;
  source_task_id: string;
  expected_generation: number;
  client_event_id: string | null;
  attempts: number;
  phase: "pending" | "provider_done";
  new_event_id: string | null;
  result_reason: string | null;
  /** Round 7 fencing token — fresh per claim/reclaim; every worker write
   *  after the claim is scoped by it (see create-worker.ts). */
  claim_token: string;
  task_due_at: string;
  task_end_at: string;
  task_title: string;
  task_assignee_id: string;
};

/** Round 7: fn_expire_exhausted_calendar_creations now returns one row of
 *  (failed_count, needs_repair_count) instead of a bare integer — a
 *  provider_done exhaustion is a repair state, not a plain failure. Round
 *  9 adds needs_repair_ids so the cron route can attach the exact ledger
 *  rows to a telemetry event. */
type ExpireExhaustedRow = {
  failed_count: number;
  needs_repair_count: number;
  needs_repair_ids: string[];
};

type ClaimRpcClient = {
  rpc(
    fn: "fn_claim_calendar_creations",
    args: { p_limit: number },
  ): Promise<RpcResult<ClaimCalendarCreationsRow[]>>;
  rpc(fn: "fn_expire_exhausted_calendar_creations"): Promise<RpcResult<ExpireExhaustedRow[]>>;
};

function claimCalendarCreations(
  client: SupabaseClient<Database>,
  limit: number,
): Promise<RpcResult<ClaimCalendarCreationsRow[]>> {
  return (client as unknown as ClaimRpcClient).rpc("fn_claim_calendar_creations", {
    p_limit: limit,
  });
}

function expireExhaustedCalendarCreations(
  client: SupabaseClient<Database>,
): Promise<RpcResult<ExpireExhaustedRow[]>> {
  return (client as unknown as ClaimRpcClient).rpc("fn_expire_exhausted_calendar_creations");
}

// task_calendar_mutations columns not on the generated Database type yet
// (same local-cast rationale) — used by the lease/backoff/exhaustion tests
// below to read/backdate next_attempt_at and phase directly.
type LedgerLeaseRow = { attempts: number; phase: string; next_attempt_at: string | null };
function ledgerLeaseReader(client: SupabaseClient<Database> = db) {
  return client as unknown as {
    from(table: "task_calendar_mutations"): {
      select(columns: string): {
        eq(
          column: "id",
          value: string,
        ): { single(): Promise<{ data: LedgerLeaseRow | null; error: { message: string } | null }> };
      };
      update(values: {
        next_attempt_at?: string | null;
        attempts?: number;
        phase?: string;
      }): {
        eq(
          column: "id",
          value: string,
        ): Promise<{ data: null; error: { message: string } | null }>;
      };
      insert(values: {
        org_id: string;
        calendar_chain_id: string;
        operation: string;
        phase: string;
        source_task_id: string;
        old_assignee_id: string;
        expected_generation: number;
      }): Promise<{ data: null; error: { message: string; code?: string } | null }>;
    };
  };
}

const serviceClient = createTestClient();
const db = serviceClient;
const createdUserIds: string[] = [];

function uniqueEmail(label: string): string {
  return `mig20260814170000-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@bmhgroupkc.com`;
}

function uniquePhone(): string {
  return `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
}

/** Unauthenticated PostgREST client (anon role) — no session, no JWT. */
function anonClient(): SupabaseClient<Database> {
  const env = loadTestEnv();
  const url = process.env.TEST_SUPABASE_URL ?? env.TEST_SUPABASE_URL;
  const key = process.env.TEST_SUPABASE_ANON_KEY ?? env.TEST_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error("Missing TEST_SUPABASE_URL or TEST_SUPABASE_ANON_KEY.");
  }
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function createUserForOrg(orgId: string, role: "owner" | "member" = "member") {
  const user = await createOrgUser(serviceClient, {
    orgId,
    email: uniqueEmail(`${orgId.slice(-3)}-${role}`),
    role,
  });
  createdUserIds.push(user.userId);
  return { ...user, client: clientForUser(user.jwt) };
}

async function setMembershipAccessStatus(
  userId: string,
  orgId: string,
  status: "active" | "suspended",
): Promise<void> {
  const { error } = await db
    .from("memberships")
    .update({ access_status: status })
    .eq("user_id", userId)
    .eq("org_id", orgId);
  expect(error).toBeNull();
}

async function setTimezonePref(
  userId: string,
  timezone: string,
  channel: "google_calendar" | "slack" = "google_calendar",
): Promise<void> {
  const { error } = await db
    .from("user_integration_prefs")
    .upsert({ user_id: userId, channel, timezone });
  expect(error).toBeNull();
}

async function insertContact(orgId = BMH_ORG_ID, label = "Contact"): Promise<string> {
  const { data, error } = await db
    .from("contacts")
    .insert({
      org_id: orgId,
      contact_type: "person",
      first_name: label,
      last_name: "Test",
      phone_1: uniquePhone(),
      phone_1_type: "mobile",
    })
    .select("id")
    .single();
  expect(error).toBeNull();
  return data!.id;
}

async function insertProperty(
  orgId = BMH_ORG_ID,
  status: string = "prospect",
): Promise<string> {
  const { data, error } = await db
    .from("properties")
    .insert({
      org_id: orgId,
      address: `appt-booking ${crypto.randomUUID()}`,
      state: "MO",
      status,
    })
    .select("id")
    .single();
  expect(error).toBeNull();
  return data!.id;
}

function windowArgs() {
  return {
    p_start: new Date(Date.now() + 3600_000).toISOString(),
    p_end: new Date(Date.now() + 5400_000).toISOString(),
  };
}

beforeAll(async () => {
  await seedTwoOrgs(serviceClient);
});

beforeEach(async () => {
  await resetTenantTables(serviceClient);
});

afterAll(async () => {
  for (const userId of createdUserIds) {
    await serviceClient.auth.admin.deleteUser(userId);
  }
  await resetTenantTables(serviceClient);
});

describe("Migration 20260814170000 — appointment booking RPCs", () => {
  describe("fn_get_member_timezone", () => {
    it("falls back to America/Chicago when the target has no prefs row", async () => {
      const caller = await createUserForOrg(BMH_ORG_ID);
      const target = await createUserForOrg(BMH_ORG_ID);

      const { data, error } = await getMemberTimezone(caller.client, target.userId);
      expect(error).toBeNull();
      expect(data).toBe("America/Chicago");
    });

    it("returns the target's saved timezone, preferring the google_calendar channel", async () => {
      const caller = await createUserForOrg(BMH_ORG_ID);
      const target = await createUserForOrg(BMH_ORG_ID);
      await setTimezonePref(target.userId, "America/Denver", "slack");
      await setTimezonePref(target.userId, "America/New_York", "google_calendar");

      const { data, error } = await getMemberTimezone(caller.client, target.userId);
      expect(error).toBeNull();
      expect(data).toBe("America/New_York");
    });

    it("rejects when caller and target share no org", async () => {
      const outsider = await createUserForOrg(TEST_ORG_B_ID);
      const target = await createUserForOrg(BMH_ORG_ID);

      const { data, error } = await getMemberTimezone(outsider.client, target.userId);
      expect(data).toBeNull();
      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/no shared active org/i);
    });

    it("rejects when the target's membership in the shared org is inactive", async () => {
      const caller = await createUserForOrg(BMH_ORG_ID);
      const target = await createUserForOrg(BMH_ORG_ID);
      await setMembershipAccessStatus(target.userId, BMH_ORG_ID, "suspended");

      const { data, error } = await getMemberTimezone(caller.client, target.userId);
      expect(data).toBeNull();
      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/no shared active org/i);
    });

    it("rejects an unauthenticated (anon) caller", async () => {
      const target = await createUserForOrg(BMH_ORG_ID);
      const { data, error } = await getMemberTimezone(anonClient(), target.userId);
      expect(data).toBeNull();
      expect(error).not.toBeNull();
      expect(error?.code ?? "").toMatch(/42501/);
    });
  });

  describe("fn_book_appointment — happy path (property booking)", () => {
    it("books atomically: task + ledger created, chain ids agree, client_event_id is valid base32hex, prospect promoted, dispo set", async () => {
      const booker = await createUserForOrg(BMH_ORG_ID);
      const assignee = await createUserForOrg(BMH_ORG_ID);
      const contactId = await insertContact();
      const propertyId = await insertProperty(BMH_ORG_ID, "prospect");
      const { p_start, p_end } = windowArgs();

      // Called on the assignee's own client-facing client — this is a
      // "direct member call" (not service role), which is the point: any
      // active org member can book, the RPC's own checks gate it.
      const { data, error } = await bookAppointment(booker.client, {
        p_org: BMH_ORG_ID,
        p_assignee: assignee.userId,
        p_start,
        p_end,
        p_timezone: "America/Chicago",
        p_title: "Walkthrough",
        p_contact: contactId,
        p_property: propertyId,
        p_description: "Bring comps",
      });

      expect(error).toBeNull();
      expect(data).not.toBeNull();
      expect(data!.already_qualified).toBe(false);
      const { task_id: taskId, calendar_chain_id: chainId } = data!;

      const { data: task, error: taskErr } = await db
        .from("tasks")
        .select(
          "id, org_id, type, status, assignee_id, contact_id, related_property_id, title, description, due_at, end_at, calendar_chain_id, calendar_generation, created_by, outcome, reminder_claimed_at",
        )
        .eq("id", taskId)
        .single();
      expect(taskErr).toBeNull();
      expect(task).toMatchObject({
        org_id: BMH_ORG_ID,
        type: "appointment",
        status: "open",
        assignee_id: assignee.userId,
        contact_id: contactId,
        related_property_id: propertyId,
        title: "Walkthrough",
        description: "Bring comps",
        due_at: p_start,
        end_at: p_end,
        calendar_chain_id: chainId,
        calendar_generation: 0,
        // Actor is always derived server-side from auth.uid() — there is
        // no actor parameter to spoof. created_by matching the caller
        // (not, say, the assignee, or an attacker-chosen id) proves it.
        created_by: booker.userId,
        outcome: null,
        reminder_claimed_at: null,
      });

      const { data: ledgerRows, error: ledgerErr } = await db
        .from("task_calendar_mutations")
        .select(
          "id, org_id, calendar_chain_id, operation, phase, source_task_id, target_task_id, old_assignee_id, new_assignee_id, expected_generation, client_event_id",
        )
        .eq("source_task_id", taskId);
      expect(ledgerErr).toBeNull();
      expect(ledgerRows).toHaveLength(1);
      const ledger = ledgerRows![0];
      expect(ledger).toMatchObject({
        org_id: BMH_ORG_ID,
        calendar_chain_id: chainId,
        operation: "create",
        phase: "pending",
        source_task_id: taskId,
        target_task_id: null,
        old_assignee_id: assignee.userId,
        new_assignee_id: null,
        expected_generation: 0,
      });
      // Google Calendar event-id charset: lowercase [a-v0-9], 5-1024 chars.
      expect(ledger.client_event_id).toMatch(/^[a-v0-9]{5,1024}$/);

      const { data: property } = await db
        .from("properties")
        .select("status, qualified_at, qualified_by, outreach_dispo, follow_up_at")
        .eq("id", propertyId)
        .single();
      expect(property?.status).toBe("new_lead");
      expect(property?.qualified_at).not.toBeNull();
      expect(property?.qualified_by).toBe(booker.userId);
      expect(property?.outreach_dispo).toBe("booked_appointment");
      expect(property?.follow_up_at).toBeNull();
    });

    it("is idempotent on an already-qualified property: already_qualified is true, qualified_at untouched, dispo still refreshed", async () => {
      const booker = await createUserForOrg(BMH_ORG_ID);
      const assignee = await createUserForOrg(BMH_ORG_ID);
      const propertyId = await insertProperty(BMH_ORG_ID, "contacted");
      const { p_start, p_end } = windowArgs();

      const { data, error } = await bookAppointment(booker.client, {
        p_org: BMH_ORG_ID,
        p_assignee: assignee.userId,
        p_start,
        p_end,
        p_timezone: "America/Chicago",
        p_title: "Second call",
        p_property: propertyId,
      });

      expect(error).toBeNull();
      expect(data!.already_qualified).toBe(true);

      const { data: property } = await db
        .from("properties")
        .select("status, outreach_dispo")
        .eq("id", propertyId)
        .single();
      expect(property?.status).toBe("contacted"); // untouched — not a prospect
      expect(property?.outreach_dispo).toBe("booked_appointment"); // dispo write is unconditional
    });
  });

  describe("fn_book_appointment — personal block (no contact, no property)", () => {
    it("books a bare appointment with no promotion and no dispo write", async () => {
      const booker = await createUserForOrg(BMH_ORG_ID);
      const { p_start, p_end } = windowArgs();

      const { data, error } = await bookAppointment(booker.client, {
        p_org: BMH_ORG_ID,
        p_assignee: booker.userId,
        p_start,
        p_end,
        p_timezone: "America/Chicago",
        p_title: "Personal block",
      });

      expect(error).toBeNull();
      expect(data!.already_qualified).toBe(false);

      const { data: task } = await db
        .from("tasks")
        .select("contact_id, related_property_id, type, status")
        .eq("id", data!.task_id)
        .single();
      expect(task).toMatchObject({
        contact_id: null,
        related_property_id: null,
        type: "appointment",
        status: "open",
      });
    });
  });

  describe("fn_book_appointment — contact-only (no property)", () => {
    it("books against a contact with no property: no promotion, no dispo write possible", async () => {
      const booker = await createUserForOrg(BMH_ORG_ID);
      const assignee = await createUserForOrg(BMH_ORG_ID);
      const contactId = await insertContact();
      const { p_start, p_end } = windowArgs();

      const { data, error } = await bookAppointment(booker.client, {
        p_org: BMH_ORG_ID,
        p_assignee: assignee.userId,
        p_start,
        p_end,
        p_timezone: "America/Chicago",
        p_title: "Contact call",
        p_contact: contactId,
      });

      expect(error).toBeNull();
      expect(data!.already_qualified).toBe(false);

      const { data: task } = await db
        .from("tasks")
        .select("contact_id, related_property_id")
        .eq("id", data!.task_id)
        .single();
      expect(task).toMatchObject({ contact_id: contactId, related_property_id: null });
    });
  });

  describe("fn_book_appointment — hostile", () => {
    it("rejects an unauthenticated (anon) caller", async () => {
      const assignee = await createUserForOrg(BMH_ORG_ID);
      const { p_start, p_end } = windowArgs();

      const { data, error } = await bookAppointment(anonClient(), {
        p_org: BMH_ORG_ID,
        p_assignee: assignee.userId,
        p_start,
        p_end,
        p_timezone: "America/Chicago",
        p_title: "Should never exist",
      });

      expect(data).toBeNull();
      expect(error).not.toBeNull();
      expect(error?.code ?? "").toMatch(/42501/);
    });

    it("rejects an actor with no active membership in p_org (cross-org)", async () => {
      const outsider = await createUserForOrg(TEST_ORG_B_ID);
      const assignee = await createUserForOrg(BMH_ORG_ID);
      const { p_start, p_end } = windowArgs();

      const { data, error } = await bookAppointment(outsider.client, {
        p_org: BMH_ORG_ID,
        p_assignee: assignee.userId,
        p_start,
        p_end,
        p_timezone: "America/Chicago",
        p_title: "Cross-org attempt",
      });

      expect(data).toBeNull();
      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/caller has no active membership/i);
    });

    it("rejects when the assignee's membership is inactive", async () => {
      const booker = await createUserForOrg(BMH_ORG_ID);
      const assignee = await createUserForOrg(BMH_ORG_ID);
      await setMembershipAccessStatus(assignee.userId, BMH_ORG_ID, "suspended");
      const { p_start, p_end } = windowArgs();

      const { data, error } = await bookAppointment(booker.client, {
        p_org: BMH_ORG_ID,
        p_assignee: assignee.userId,
        p_start,
        p_end,
        p_timezone: "America/Chicago",
        p_title: "Suspended assignee",
      });

      expect(data).toBeNull();
      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/assignee has no active membership/i);
    });

    it("rejects a timezone-label mismatch against the assignee's authoritative pref", async () => {
      const booker = await createUserForOrg(BMH_ORG_ID);
      const assignee = await createUserForOrg(BMH_ORG_ID);
      await setTimezonePref(assignee.userId, "America/Chicago");
      const { p_start, p_end } = windowArgs();

      const { data, error } = await bookAppointment(booker.client, {
        p_org: BMH_ORG_ID,
        p_assignee: assignee.userId,
        p_start,
        p_end,
        p_timezone: "America/New_York", // hostile: claims a different zone
        p_title: "Zone mismatch",
      });

      expect(data).toBeNull();
      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/timezone mismatch/i);
    });

    it("rejects p_end <= p_start", async () => {
      const booker = await createUserForOrg(BMH_ORG_ID);
      const assignee = await createUserForOrg(BMH_ORG_ID);
      const start = new Date(Date.now() + 3600_000).toISOString();

      const { data, error } = await bookAppointment(booker.client, {
        p_org: BMH_ORG_ID,
        p_assignee: assignee.userId,
        p_start: start,
        p_end: start,
        p_timezone: "America/Chicago",
        p_title: "Zero-length",
      });

      expect(data).toBeNull();
      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/end must be after start/i);
    });

    it("rejects a null/blank title", async () => {
      const booker = await createUserForOrg(BMH_ORG_ID);
      const assignee = await createUserForOrg(BMH_ORG_ID);
      const { p_start, p_end } = windowArgs();

      const { data, error } = await bookAppointment(booker.client, {
        p_org: BMH_ORG_ID,
        p_assignee: assignee.userId,
        p_start,
        p_end,
        p_timezone: "America/Chicago",
        p_title: "   ",
      });

      expect(data).toBeNull();
      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/title is required/i);
    });

    // Codex round 4: a hostile direct-RPC caller bypasses every client-side
    // form constraint, so the window bounds must be enforced in the RPC
    // itself, not just the booking form.
    it("rejects an infinite p_start", async () => {
      const booker = await createUserForOrg(BMH_ORG_ID);
      const assignee = await createUserForOrg(BMH_ORG_ID);
      const { p_end } = windowArgs();

      const { data, error } = await bookAppointment(booker.client, {
        p_org: BMH_ORG_ID,
        p_assignee: assignee.userId,
        p_start: "infinity",
        p_end,
        p_timezone: "America/Chicago",
        p_title: "Hostile infinite start",
      });

      expect(data).toBeNull();
      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/finite timestamps/i);
    });

    it("rejects an infinite p_end", async () => {
      const booker = await createUserForOrg(BMH_ORG_ID);
      const assignee = await createUserForOrg(BMH_ORG_ID);
      const { p_start } = windowArgs();

      const { data, error } = await bookAppointment(booker.client, {
        p_org: BMH_ORG_ID,
        p_assignee: assignee.userId,
        p_start,
        p_end: "infinity",
        p_timezone: "America/Chicago",
        p_title: "Hostile infinite end",
      });

      expect(data).toBeNull();
      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/finite timestamps/i);
    });

    it("rejects a 3-minute duration (below the 15-minute floor)", async () => {
      const booker = await createUserForOrg(BMH_ORG_ID);
      const assignee = await createUserForOrg(BMH_ORG_ID);
      const start = new Date(Date.now() + 3600_000);
      const end = new Date(start.getTime() + 3 * 60_000);

      const { data, error } = await bookAppointment(booker.client, {
        p_org: BMH_ORG_ID,
        p_assignee: assignee.userId,
        p_start: start.toISOString(),
        p_end: end.toISOString(),
        p_timezone: "America/Chicago",
        p_title: "Too short",
      });

      expect(data).toBeNull();
      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/duration must be between/i);
    });

    it("rejects a 25-hour duration (above the 24-hour ceiling)", async () => {
      const booker = await createUserForOrg(BMH_ORG_ID);
      const assignee = await createUserForOrg(BMH_ORG_ID);
      const start = new Date(Date.now() + 3600_000);
      const end = new Date(start.getTime() + 25 * 3600_000);

      const { data, error } = await bookAppointment(booker.client, {
        p_org: BMH_ORG_ID,
        p_assignee: assignee.userId,
        p_start: start.toISOString(),
        p_end: end.toISOString(),
        p_timezone: "America/Chicago",
        p_title: "Too long",
      });

      expect(data).toBeNull();
      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/duration must be between/i);
    });

    it("rejects a p_start 3 years out (beyond the 2-year ceiling)", async () => {
      const booker = await createUserForOrg(BMH_ORG_ID);
      const assignee = await createUserForOrg(BMH_ORG_ID);
      const start = new Date(Date.now() + 3 * 365 * 24 * 3600_000);
      const end = new Date(start.getTime() + 1800_000);

      const { data, error } = await bookAppointment(booker.client, {
        p_org: BMH_ORG_ID,
        p_assignee: assignee.userId,
        p_start: start.toISOString(),
        p_end: end.toISOString(),
        p_timezone: "America/Chicago",
        p_title: "Too far out",
      });

      expect(data).toBeNull();
      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/within 1 hour in the past and 2 years/i);
    });

    it("rejects a p_start of yesterday (beyond the 1-hour grace window into the past)", async () => {
      const booker = await createUserForOrg(BMH_ORG_ID);
      const assignee = await createUserForOrg(BMH_ORG_ID);
      const start = new Date(Date.now() - 24 * 3600_000);
      const end = new Date(start.getTime() + 1800_000);

      const { data, error } = await bookAppointment(booker.client, {
        p_org: BMH_ORG_ID,
        p_assignee: assignee.userId,
        p_start: start.toISOString(),
        p_end: end.toISOString(),
        p_timezone: "America/Chicago",
        p_title: "Yesterday",
      });

      expect(data).toBeNull();
      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/within 1 hour in the past and 2 years/i);
    });
  });

  // The Supabase JS client auto-commits every PostgREST call, so proving the
  // ACTOR's `FOR SHARE OF m` check (Codex round 2) actually serializes
  // against a concurrent suspension needs two raw `pg` connections holding
  // uncommitted work open — same capability/rationale as
  // 20260814150000_appointments_schema.integration.test.ts's
  // membership-suspension race describe block (mirrored here for the
  // ACTOR side rather than the assignee side, and for fn_book_appointment
  // rather than a bare tasks INSERT).
  describe("fn_book_appointment — actor-suspension race (raw pg, two connections)", () => {
    let connA: Client;
    let connB: Client;

    beforeEach(async () => {
      connA = new Client({ connectionString: testDbUrl() });
      connB = new Client({ connectionString: testDbUrl() });
      await connA.connect();
      await connB.connect();
      await connA.query("set statement_timeout = 0");
      await connB.query("set statement_timeout = 0");
    });

    afterEach(async () => {
      await connA.query("rollback").catch(() => {});
      await connB.query("rollback").catch(() => {});
      await connA.end().catch(() => {});
      await connB.end().catch(() => {});
    });

    async function stillBlockedAfter(
      promise: Promise<unknown>,
      ms: number,
    ): Promise<"blocked" | "resolved"> {
      const sentinel = Symbol("timeout");
      const raced = await Promise.race([
        promise.catch(() => sentinel),
        new Promise((resolve) => setTimeout(() => resolve(sentinel), ms)).then(
          () => "timeout-won" as const,
        ),
      ]);
      return raced === "timeout-won" ? "blocked" : "resolved";
    }

    const RPC_SQL = `
      select public.fn_book_appointment(
        p_org => $1::uuid, p_assignee => $2::uuid, p_start => $3::timestamptz,
        p_end => $4::timestamptz, p_timezone => $5::text, p_title => $6::text
      ) as result
    `;

    it("suspend wins: a suspension committed while the booking is blocked on FOR SHARE fails the booking", async () => {
      const booker = await createUserForOrg(BMH_ORG_ID);
      const assignee = await createUserForOrg(BMH_ORG_ID);
      const { p_start, p_end } = windowArgs();
      const jwtClaims = JSON.stringify({ sub: booker.userId, role: "authenticated" });
      const args = [BMH_ORG_ID, assignee.userId, p_start, p_end, "America/Chicago", "Race test"];

      // connA holds a ROW EXCLUSIVE lock on the booker's own membership row
      // until commit. connB's booking call runs the actor check's
      // `FOR SHARE OF m` against that same row and must block on it.
      await connA.query("begin");
      await connA.query(
        "update memberships set access_status = 'suspended' where user_id = $1 and org_id = $2",
        [booker.userId, BMH_ORG_ID],
      );

      await connB.query("begin");
      await connB.query("select set_config('request.jwt.claims', $1, true)", [jwtClaims]);
      const bookPromise = connB.query(RPC_SQL, args);

      expect(await stillBlockedAfter(bookPromise, 1500)).toBe("blocked");

      // Commit the suspension: connB's blocked FOR SHARE proceeds and now
      // observes access_status = 'suspended' — the function must raise the
      // same "no active membership" error as the non-race hostile case.
      await connA.query("commit");

      await expect(bookPromise).rejects.toThrow(/caller has no active membership/i);
    });

    it("book wins: a booking committed while a suspension is blocked on the row lock still succeeds; the suspension commits cleanly right after", async () => {
      const booker = await createUserForOrg(BMH_ORG_ID);
      const assignee = await createUserForOrg(BMH_ORG_ID);
      const { p_start, p_end } = windowArgs();
      const jwtClaims = JSON.stringify({ sub: booker.userId, role: "authenticated" });
      const args = [BMH_ORG_ID, assignee.userId, p_start, p_end, "America/Chicago", "Race test"];

      // connA's booking call takes the FOR SHARE lock on the booker's own
      // membership row and — because the transaction stays open — holds it
      // past the call's completion, until commit. connB's suspension needs
      // ROW EXCLUSIVE on that same row and must block until then.
      await connA.query("begin");
      await connA.query("select set_config('request.jwt.claims', $1, true)", [jwtClaims]);
      const booked = await connA.query<{ result: BookAppointmentRow }>(RPC_SQL, args);

      const suspendPromise = connB.query(
        "update memberships set access_status = 'suspended' where user_id = $1 and org_id = $2",
        [booker.userId, BMH_ORG_ID],
      );

      expect(await stillBlockedAfter(suspendPromise, 1500)).toBe("blocked");

      await connA.query("commit");
      await suspendPromise;

      expect(booked.rows[0].result.duplicate).toBe(false);

      const { data: membership } = await db
        .from("memberships")
        .select("access_status")
        .eq("user_id", booker.userId)
        .eq("org_id", BMH_ORG_ID)
        .single();
      expect((membership as { access_status: string }).access_status).toBe("suspended");
    });
  });

  describe("fn_book_appointment — idempotent re-booking", () => {
    it("a second booking on the same property creates a second appointment on a new chain, without breaking", async () => {
      const booker = await createUserForOrg(BMH_ORG_ID);
      const assignee = await createUserForOrg(BMH_ORG_ID);
      const propertyId = await insertProperty(BMH_ORG_ID, "prospect");
      const first = windowArgs();

      const { data: firstBooking, error: firstErr } = await bookAppointment(booker.client, {
        p_org: BMH_ORG_ID,
        p_assignee: assignee.userId,
        p_start: first.p_start,
        p_end: first.p_end,
        p_timezone: "America/Chicago",
        p_title: "First booking",
        p_property: propertyId,
      });
      expect(firstErr).toBeNull();
      expect(firstBooking!.already_qualified).toBe(false);

      const second = {
        p_start: new Date(Date.now() + 90_000_000).toISOString(),
        p_end: new Date(Date.now() + 91_800_000).toISOString(),
      };
      const { data: secondBooking, error: secondErr } = await bookAppointment(booker.client, {
        p_org: BMH_ORG_ID,
        p_assignee: assignee.userId,
        p_start: second.p_start,
        p_end: second.p_end,
        p_timezone: "America/Chicago",
        p_title: "Re-book",
        p_property: propertyId,
      });
      expect(secondErr).toBeNull();
      expect(secondBooking!.already_qualified).toBe(true); // already promoted by the first booking

      expect(secondBooking!.task_id).not.toBe(firstBooking!.task_id);
      expect(secondBooking!.calendar_chain_id).not.toBe(firstBooking!.calendar_chain_id);

      const { data: tasks } = await db
        .from("tasks")
        .select("id, calendar_chain_id")
        .eq("related_property_id", propertyId);
      expect(tasks).toHaveLength(2);

      const { data: ledgerRows } = await db
        .from("task_calendar_mutations")
        .select("id, calendar_chain_id, source_task_id")
        .in("source_task_id", [firstBooking!.task_id, secondBooking!.task_id]);
      expect(ledgerRows).toHaveLength(2);
    });
  });

  describe("fn_book_appointment — booking_idempotency_key", () => {
    it("sequential replay with the same key returns the identical task, not a second row", async () => {
      const booker = await createUserForOrg(BMH_ORG_ID);
      const assignee = await createUserForOrg(BMH_ORG_ID);
      const key = crypto.randomUUID();
      const { p_start, p_end } = windowArgs();

      const first = await bookAppointment(booker.client, {
        p_org: BMH_ORG_ID,
        p_assignee: assignee.userId,
        p_start,
        p_end,
        p_timezone: "America/Chicago",
        p_title: "First attempt",
        p_idempotency_key: key,
      });
      expect(first.error).toBeNull();
      expect(first.data!.duplicate).toBe(false);

      // Simulates the client never seeing the first response (dropped
      // connection) and retrying with the SAME key and a slightly
      // different title — the retry must return the ORIGINAL booking
      // untouched, not create a second task or update the title.
      const retry = await bookAppointment(booker.client, {
        p_org: BMH_ORG_ID,
        p_assignee: assignee.userId,
        p_start,
        p_end,
        p_timezone: "America/Chicago",
        p_title: "Retry after dropped response",
        p_idempotency_key: key,
      });
      expect(retry.error).toBeNull();
      expect(retry.data!.duplicate).toBe(true);
      expect(retry.data!.task_id).toBe(first.data!.task_id);
      expect(retry.data!.calendar_chain_id).toBe(first.data!.calendar_chain_id);

      const { data: rows, error: rowsErr } = await tasksByIdempotencyKey(key);
      expect(rowsErr).toBeNull();
      expect(rows).toHaveLength(1);
      expect(rows![0].title).toBe("First attempt");
    });

    it("replay-before-validation: a replay after the assignee was suspended still returns the original booking", async () => {
      const booker = await createUserForOrg(BMH_ORG_ID);
      const assignee = await createUserForOrg(BMH_ORG_ID);
      const key = crypto.randomUUID();
      const { p_start, p_end } = windowArgs();

      const first = await bookAppointment(booker.client, {
        p_org: BMH_ORG_ID,
        p_assignee: assignee.userId,
        p_start,
        p_end,
        p_timezone: "America/Chicago",
        p_title: "Booked while assignee was active",
        p_idempotency_key: key,
      });
      expect(first.error).toBeNull();
      expect(first.data!.duplicate).toBe(false);

      // The assignee's membership going inactive AFTER the original booking
      // committed must not turn a same-key replay into an error — the
      // idempotency lookup runs before the assignee-membership check
      // (Codex round 2), so it never re-evaluates a fact the original
      // booking already settled.
      await setMembershipAccessStatus(assignee.userId, BMH_ORG_ID, "suspended");

      const retry = await bookAppointment(booker.client, {
        p_org: BMH_ORG_ID,
        p_assignee: assignee.userId,
        p_start,
        p_end,
        p_timezone: "America/Chicago",
        p_title: "Booked while assignee was active",
        p_idempotency_key: key,
      });

      expect(retry.error).toBeNull();
      expect(retry.data!.duplicate).toBe(true);
      expect(retry.data!.task_id).toBe(first.data!.task_id);
    });

    it("replay-before-validation: a replay after the assignee's timezone pref changed still returns the original booking", async () => {
      const booker = await createUserForOrg(BMH_ORG_ID);
      const assignee = await createUserForOrg(BMH_ORG_ID);
      await setTimezonePref(assignee.userId, "America/Chicago");
      const key = crypto.randomUUID();
      const { p_start, p_end } = windowArgs();

      const first = await bookAppointment(booker.client, {
        p_org: BMH_ORG_ID,
        p_assignee: assignee.userId,
        p_start,
        p_end,
        p_timezone: "America/Chicago",
        p_title: "Booked under Chicago pref",
        p_idempotency_key: key,
      });
      expect(first.error).toBeNull();
      expect(first.data!.duplicate).toBe(false);

      // Change the assignee's authoritative pref after booking. A replay
      // sent with the now-STALE "America/Chicago" label would fail the
      // timezone-mismatch check if that check ran — proving the idempotency
      // lookup really does short-circuit before it, not just that the
      // label happens to still agree.
      await setTimezonePref(assignee.userId, "America/Denver");

      const retry = await bookAppointment(booker.client, {
        p_org: BMH_ORG_ID,
        p_assignee: assignee.userId,
        p_start,
        p_end,
        p_timezone: "America/Chicago",
        p_title: "Booked under Chicago pref",
        p_idempotency_key: key,
      });

      expect(retry.error).toBeNull();
      expect(retry.data!.duplicate).toBe(true);
      expect(retry.data!.task_id).toBe(first.data!.task_id);
    });

    it("different keys create distinct tasks", async () => {
      const booker = await createUserForOrg(BMH_ORG_ID);
      const assignee = await createUserForOrg(BMH_ORG_ID);
      const { p_start, p_end } = windowArgs();

      const a = await bookAppointment(booker.client, {
        p_org: BMH_ORG_ID,
        p_assignee: assignee.userId,
        p_start,
        p_end,
        p_timezone: "America/Chicago",
        p_title: "Booking A",
        p_idempotency_key: crypto.randomUUID(),
      });
      const b = await bookAppointment(booker.client, {
        p_org: BMH_ORG_ID,
        p_assignee: assignee.userId,
        p_start,
        p_end,
        p_timezone: "America/Chicago",
        p_title: "Booking B",
        p_idempotency_key: crypto.randomUUID(),
      });

      expect(a.error).toBeNull();
      expect(b.error).toBeNull();
      expect(a.data!.duplicate).toBe(false);
      expect(b.data!.duplicate).toBe(false);
      expect(a.data!.task_id).not.toBe(b.data!.task_id);
    });

    it("omitting the key entirely (default null) never triggers the duplicate path", async () => {
      const booker = await createUserForOrg(BMH_ORG_ID);
      const assignee = await createUserForOrg(BMH_ORG_ID);
      const { p_start, p_end } = windowArgs();

      const a = await bookAppointment(booker.client, {
        p_org: BMH_ORG_ID,
        p_assignee: assignee.userId,
        p_start,
        p_end,
        p_timezone: "America/Chicago",
        p_title: "No key A",
      });
      const b = await bookAppointment(booker.client, {
        p_org: BMH_ORG_ID,
        p_assignee: assignee.userId,
        p_start,
        p_end,
        p_timezone: "America/Chicago",
        p_title: "No key B",
      });

      expect(a.data!.duplicate).toBe(false);
      expect(b.data!.duplicate).toBe(false);
      expect(a.data!.task_id).not.toBe(b.data!.task_id);
    });

    describe("round 9 — replay validates the request against every immutable field", () => {
      it("a matched replay returns duplicate:true with the persisted property/contact linkage, not the request's", async () => {
        const booker = await createUserForOrg(BMH_ORG_ID);
        const assignee = await createUserForOrg(BMH_ORG_ID);
        const contactId = await insertContact();
        const propertyId = await insertProperty(BMH_ORG_ID, "prospect");
        const key = crypto.randomUUID();
        const { p_start, p_end } = windowArgs();
        const args = {
          p_org: BMH_ORG_ID,
          p_assignee: assignee.userId,
          p_start,
          p_end,
          p_timezone: "America/Chicago",
          p_title: "Canonical linkage",
          p_contact: contactId,
          p_property: propertyId,
          p_description: "Bring comps",
          p_idempotency_key: key,
        };

        const first = await bookAppointment(booker.client, args);
        expect(first.error).toBeNull();
        expect(first.data!.duplicate).toBe(false);
        expect(first.data!.related_property_id).toBe(propertyId);
        expect(first.data!.contact_id).toBe(contactId);

        const retry = await bookAppointment(booker.client, args);
        expect(retry.error).toBeNull();
        expect(retry.data!.duplicate).toBe(true);
        expect(retry.data!.task_id).toBe(first.data!.task_id);
        expect(retry.data!.related_property_id).toBe(propertyId);
        expect(retry.data!.contact_id).toBe(contactId);
      });

      it("rejects a replay whose property disagrees with the original booking", async () => {
        const booker = await createUserForOrg(BMH_ORG_ID);
        const assignee = await createUserForOrg(BMH_ORG_ID);
        const propertyA = await insertProperty(BMH_ORG_ID, "prospect");
        const propertyB = await insertProperty(BMH_ORG_ID, "prospect");
        const key = crypto.randomUUID();
        const { p_start, p_end } = windowArgs();

        const first = await bookAppointment(booker.client, {
          p_org: BMH_ORG_ID,
          p_assignee: assignee.userId,
          p_start,
          p_end,
          p_timezone: "America/Chicago",
          p_title: "Original booking",
          p_property: propertyA,
          p_idempotency_key: key,
        });
        expect(first.error).toBeNull();

        const { data, error } = await bookAppointment(booker.client, {
          p_org: BMH_ORG_ID,
          p_assignee: assignee.userId,
          p_start,
          p_end,
          p_timezone: "America/Chicago",
          p_title: "Original booking",
          p_property: propertyB, // mismatched
          p_idempotency_key: key,
        });

        expect(data).toBeNull();
        expect(error).not.toBeNull();
        expect(error?.message).toMatch(/idempotency key reuse with different request/i);
      });

      it("rejects a replay whose contact disagrees with the original booking", async () => {
        const booker = await createUserForOrg(BMH_ORG_ID);
        const assignee = await createUserForOrg(BMH_ORG_ID);
        const contactA = await insertContact();
        const contactB = await insertContact();
        const key = crypto.randomUUID();
        const { p_start, p_end } = windowArgs();

        const first = await bookAppointment(booker.client, {
          p_org: BMH_ORG_ID,
          p_assignee: assignee.userId,
          p_start,
          p_end,
          p_timezone: "America/Chicago",
          p_title: "Original booking",
          p_contact: contactA,
          p_idempotency_key: key,
        });
        expect(first.error).toBeNull();

        const { data, error } = await bookAppointment(booker.client, {
          p_org: BMH_ORG_ID,
          p_assignee: assignee.userId,
          p_start,
          p_end,
          p_timezone: "America/Chicago",
          p_title: "Original booking",
          p_contact: contactB, // mismatched
          p_idempotency_key: key,
        });

        expect(data).toBeNull();
        expect(error).not.toBeNull();
        expect(error?.message).toMatch(/idempotency key reuse with different request/i);
      });

      it("rejects a replay whose assignee disagrees with the original booking", async () => {
        const booker = await createUserForOrg(BMH_ORG_ID);
        const assigneeA = await createUserForOrg(BMH_ORG_ID);
        const assigneeB = await createUserForOrg(BMH_ORG_ID);
        const key = crypto.randomUUID();
        const { p_start, p_end } = windowArgs();

        const first = await bookAppointment(booker.client, {
          p_org: BMH_ORG_ID,
          p_assignee: assigneeA.userId,
          p_start,
          p_end,
          p_timezone: "America/Chicago",
          p_title: "Original booking",
          p_idempotency_key: key,
        });
        expect(first.error).toBeNull();

        const { data, error } = await bookAppointment(booker.client, {
          p_org: BMH_ORG_ID,
          p_assignee: assigneeB.userId, // mismatched
          p_start,
          p_end,
          p_timezone: "America/Chicago",
          p_title: "Original booking",
          p_idempotency_key: key,
        });

        expect(data).toBeNull();
        expect(error).not.toBeNull();
        expect(error?.message).toMatch(/idempotency key reuse with different request/i);
      });

      it("rejects a replay whose start/end window disagrees with the original booking", async () => {
        const booker = await createUserForOrg(BMH_ORG_ID);
        const assignee = await createUserForOrg(BMH_ORG_ID);
        const key = crypto.randomUUID();
        const { p_start, p_end } = windowArgs();

        const first = await bookAppointment(booker.client, {
          p_org: BMH_ORG_ID,
          p_assignee: assignee.userId,
          p_start,
          p_end,
          p_timezone: "America/Chicago",
          p_title: "Original booking",
          p_idempotency_key: key,
        });
        expect(first.error).toBeNull();

        const { data, error } = await bookAppointment(booker.client, {
          p_org: BMH_ORG_ID,
          p_assignee: assignee.userId,
          p_start: new Date(new Date(p_start).getTime() + 1_800_000).toISOString(), // mismatched
          p_end: new Date(new Date(p_end).getTime() + 1_800_000).toISOString(), // mismatched
          p_timezone: "America/Chicago",
          p_title: "Original booking",
          p_idempotency_key: key,
        });

        expect(data).toBeNull();
        expect(error).not.toBeNull();
        expect(error?.message).toMatch(/idempotency key reuse with different request/i);
      });

      it("rejects a replay whose title disagrees with the original booking", async () => {
        const booker = await createUserForOrg(BMH_ORG_ID);
        const assignee = await createUserForOrg(BMH_ORG_ID);
        const key = crypto.randomUUID();
        const { p_start, p_end } = windowArgs();

        const first = await bookAppointment(booker.client, {
          p_org: BMH_ORG_ID,
          p_assignee: assignee.userId,
          p_start,
          p_end,
          p_timezone: "America/Chicago",
          p_title: "Original title",
          p_idempotency_key: key,
        });
        expect(first.error).toBeNull();

        const { data, error } = await bookAppointment(booker.client, {
          p_org: BMH_ORG_ID,
          p_assignee: assignee.userId,
          p_start,
          p_end,
          p_timezone: "America/Chicago",
          p_title: "Different title", // mismatched
          p_idempotency_key: key,
        });

        expect(data).toBeNull();
        expect(error).not.toBeNull();
        expect(error?.message).toMatch(/idempotency key reuse with different request/i);
      });
    });

    // The Supabase JS client auto-commits every PostgREST call, so proving
    // the unique_violation handler (as opposed to the pre-write SELECT
    // exercised above) needs two raw `pg` connections that can each hold
    // an uncommitted insert open while the other collides with it — same
    // capability/rationale as the membership-suspension race tests in
    // 20260814150000_appointments_schema.integration.test.ts.
    describe("concurrent replay (raw pg, two connections)", () => {
      let connA: Client;
      let connB: Client;

      beforeEach(async () => {
        connA = new Client({ connectionString: testDbUrl() });
        connB = new Client({ connectionString: testDbUrl() });
        await connA.connect();
        await connB.connect();
        await connA.query("set statement_timeout = 0");
        await connB.query("set statement_timeout = 0");
      });

      afterEach(async () => {
        await connA.query("rollback").catch(() => {});
        await connB.query("rollback").catch(() => {});
        await connA.end().catch(() => {});
        await connB.end().catch(() => {});
      });

      /** Resolves "blocked" if `promise` is still pending after `ms`, else "resolved". */
      async function stillBlockedAfter(
        promise: Promise<unknown>,
        ms: number,
      ): Promise<"blocked" | "resolved"> {
        const sentinel = Symbol("timeout");
        const raced = await Promise.race([
          promise.catch(() => sentinel),
          new Promise((resolve) => setTimeout(() => resolve(sentinel), ms)).then(
            () => "timeout-won" as const,
          ),
        ]);
        return raced === "timeout-won" ? "blocked" : "resolved";
      }

      it("both callers get the same task id; only one row is ever committed", async () => {
        const booker = await createUserForOrg(BMH_ORG_ID);
        const assignee = await createUserForOrg(BMH_ORG_ID);
        const key = crypto.randomUUID();
        const { p_start, p_end } = windowArgs();
        // Raw connections aren't PostgREST — auth.uid() reads
        // request.jwt.claims off the session GUC, so it has to be set
        // explicitly to simulate the authenticated booker.
        const jwtClaims = JSON.stringify({ sub: booker.userId, role: "authenticated" });
        const sql = `
          select public.fn_book_appointment(
            p_org => $1::uuid, p_assignee => $2::uuid, p_start => $3::timestamptz,
            p_end => $4::timestamptz, p_timezone => $5::text, p_title => $6::text,
            p_idempotency_key => $7::uuid
          ) as result
        `;
        const args = [
          BMH_ORG_ID,
          assignee.userId,
          p_start,
          p_end,
          "America/Chicago",
          "Concurrent booking",
          key,
        ];

        await connA.query("begin");
        await connA.query("select set_config('request.jwt.claims', $1, true)", [jwtClaims]);
        const resA = await connA.query<{ result: BookAppointmentRow }>(sql, args);
        // connA's insert is committed nowhere yet — connB's colliding
        // insert on the same (org_id, key) must block on it rather than
        // sailing through under READ COMMITTED.
        await connB.query("begin");
        await connB.query("select set_config('request.jwt.claims', $1, true)", [jwtClaims]);
        const resBPromise = connB.query<{ result: BookAppointmentRow }>(sql, args);

        expect(await stillBlockedAfter(resBPromise, 1500)).toBe("blocked");

        await connA.query("commit");
        const resB = await resBPromise;
        await connB.query("commit");

        const dataA = resA.rows[0].result;
        const dataB = resB.rows[0].result;
        expect(dataA.task_id).toBe(dataB.task_id);
        expect(dataA.calendar_chain_id).toBe(dataB.calendar_chain_id);
        // Exactly one connection's call is the fresh booking (duplicate
        // false) and the other resolved via the unique_violation handler
        // (duplicate true) — never both fresh, never both duplicate.
        expect([dataA.duplicate, dataB.duplicate].sort()).toEqual([false, true]);

        const { data: rows, error: rowsErr } = await tasksByIdempotencyKey(key);
        expect(rowsErr).toBeNull();
        expect(rows).toHaveLength(1);
      });
    });
  });

  describe("fn_book_appointment — ledger stays server-owned", () => {
    it("a direct INSERT into task_calendar_mutations by an authenticated member is still rejected", async () => {
      const booker = await createUserForOrg(BMH_ORG_ID);
      const assignee = await createUserForOrg(BMH_ORG_ID);
      const { p_start, p_end } = windowArgs();

      const { data: booking, error: bookErr } = await bookAppointment(booker.client, {
        p_org: BMH_ORG_ID,
        p_assignee: assignee.userId,
        p_start,
        p_end,
        p_timezone: "America/Chicago",
        p_title: "For ledger probe",
      });
      expect(bookErr).toBeNull();

      const { error } = await booker.client.from("task_calendar_mutations").insert({
        org_id: BMH_ORG_ID,
        calendar_chain_id: booking!.calendar_chain_id,
        operation: "reschedule",
        phase: "pending",
        source_task_id: booking!.task_id,
        old_assignee_id: assignee.userId,
        expected_generation: 0,
      });

      expect(error).not.toBeNull();
    });
  });

  describe("fn_claim_calendar_creations", () => {
    it("rejects an authenticated (non-service-role) caller", async () => {
      const booker = await createUserForOrg(BMH_ORG_ID);
      const { data, error } = await claimCalendarCreations(booker.client, 5);
      expect(data).toBeNull();
      expect(error).not.toBeNull();
      expect(error?.code ?? "").toMatch(/42501/);
    });

    it("rejects an anon caller", async () => {
      const { data, error } = await claimCalendarCreations(anonClient(), 5);
      expect(data).toBeNull();
      expect(error).not.toBeNull();
      expect(error?.code ?? "").toMatch(/42501/);
    });

    it("claims a pending 'create' row and joins its task fields, bumping attempts", async () => {
      const booker = await createUserForOrg(BMH_ORG_ID);
      const assignee = await createUserForOrg(BMH_ORG_ID);
      const { p_start, p_end } = windowArgs();

      const { data: booking, error: bookErr } = await bookAppointment(booker.client, {
        p_org: BMH_ORG_ID,
        p_assignee: assignee.userId,
        p_start,
        p_end,
        p_timezone: "America/Chicago",
        p_title: "Claim probe",
      });
      expect(bookErr).toBeNull();

      const { data, error } = await claimCalendarCreations(serviceClient, 10);
      expect(error).toBeNull();
      const claimed = data!.find((row) => row.source_task_id === booking!.task_id);
      expect(claimed).toMatchObject({
        org_id: BMH_ORG_ID,
        calendar_chain_id: booking!.calendar_chain_id,
        source_task_id: booking!.task_id,
        expected_generation: 0,
        attempts: 1, // bumped from 0 by the claim
        phase: "pending",
        new_event_id: null,
        result_reason: null,
        task_due_at: p_start,
        task_end_at: p_end,
        task_title: "Claim probe",
        task_assignee_id: assignee.userId,
      });
      expect(claimed!.client_event_id).toMatch(/^[a-v0-9]{5,1024}$/);
      // Round 7 fencing token: a fresh uuid minted by this claim.
      expect(claimed!.claim_token).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );

      const { data: ledgerRow } = await db
        .from("task_calendar_mutations")
        .select("attempts")
        .eq("id", claimed!.ledger_id)
        .single();
      expect((ledgerRow as { attempts: number }).attempts).toBe(1);
    });

    it("excludes rows already at the attempts cap (>= 5)", async () => {
      const booker = await createUserForOrg(BMH_ORG_ID);
      const assignee = await createUserForOrg(BMH_ORG_ID);
      const { p_start, p_end } = windowArgs();

      const { data: booking, error: bookErr } = await bookAppointment(booker.client, {
        p_org: BMH_ORG_ID,
        p_assignee: assignee.userId,
        p_start,
        p_end,
        p_timezone: "America/Chicago",
        p_title: "Exhausted probe",
      });
      expect(bookErr).toBeNull();

      const { error: bumpErr } = await db
        .from("task_calendar_mutations")
        .update({ attempts: 5 })
        .eq("source_task_id", booking!.task_id);
      expect(bumpErr).toBeNull();

      const { data, error } = await claimCalendarCreations(serviceClient, 50);
      expect(error).toBeNull();
      expect(data!.some((row) => row.source_task_id === booking!.task_id)).toBe(false);
    });

    it("a retryable outcome is NOT reclaimable until its backed-off next_attempt_at passes", async () => {
      const booker = await createUserForOrg(BMH_ORG_ID);
      const assignee = await createUserForOrg(BMH_ORG_ID);
      const { p_start, p_end } = windowArgs();

      const { data: booking, error: bookErr } = await bookAppointment(booker.client, {
        p_org: BMH_ORG_ID,
        p_assignee: assignee.userId,
        p_start,
        p_end,
        p_timezone: "America/Chicago",
        p_title: "Backoff probe",
      });
      expect(bookErr).toBeNull();

      const { data: firstClaim, error: firstErr } = await claimCalendarCreations(
        serviceClient,
        50,
      );
      expect(firstErr).toBeNull();
      const claimed = firstClaim!.find((row) => row.source_task_id === booking!.task_id);
      expect(claimed).toBeDefined();

      // Simulate a worker's retryable-outcome write (create-worker.ts
      // markRetryableFailure): push next_attempt_at into the future
      // without touching phase/attempts.
      const future = new Date(Date.now() + 5 * 60_000).toISOString();
      const { error: leaseErr } = await ledgerLeaseReader()
        .from("task_calendar_mutations")
        .update({ next_attempt_at: future })
        .eq("id", claimed!.ledger_id);
      expect(leaseErr).toBeNull();

      const { data: duringBackoff, error: duringErr } = await claimCalendarCreations(
        serviceClient,
        50,
      );
      expect(duringErr).toBeNull();
      expect(duringBackoff!.some((row) => row.ledger_id === claimed!.ledger_id)).toBe(false);

      // Backdate the lease into the past — same shape as an expired lease
      // or a completed backoff window — and the row becomes claimable again.
      const past = new Date(Date.now() - 1_000).toISOString();
      const { error: expireLeaseErr } = await ledgerLeaseReader()
        .from("task_calendar_mutations")
        .update({ next_attempt_at: past })
        .eq("id", claimed!.ledger_id);
      expect(expireLeaseErr).toBeNull();

      const { data: afterBackoff, error: afterErr } = await claimCalendarCreations(
        serviceClient,
        50,
      );
      expect(afterErr).toBeNull();
      const reclaimed = afterBackoff!.find((row) => row.ledger_id === claimed!.ledger_id);
      expect(reclaimed).toBeDefined();
      expect(reclaimed!.attempts).toBe(2); // bumped again by the second claim
      // Round 7 fencing: a reclaim mints a fresh claim_token, so the
      // worker holding the original one can never write over the row
      // again even if it wakes up after the fact.
      expect(reclaimed!.claim_token).not.toBe(claimed!.claim_token);
    });

    describe("fn_expire_exhausted_calendar_creations", () => {
      it("terminalizes an exhausted row to phase='failed' and frees the chain-serialization slot", async () => {
        const booker = await createUserForOrg(BMH_ORG_ID);
        const assignee = await createUserForOrg(BMH_ORG_ID);
        const { p_start, p_end } = windowArgs();

        const { data: booking, error: bookErr } = await bookAppointment(booker.client, {
          p_org: BMH_ORG_ID,
          p_assignee: assignee.userId,
          p_start,
          p_end,
          p_timezone: "America/Chicago",
          p_title: "Exhaustion probe",
        });
        expect(bookErr).toBeNull();

        const { data: ledgerBefore } = await db
          .from("task_calendar_mutations")
          .select("id")
          .eq("source_task_id", booking!.task_id)
          .single();
        const ledgerId = (ledgerBefore as { id: string }).id;

        // Exhausted-and-expired: attempts at the cap, lease in the past —
        // exactly the state the worker leaves a row in after its 5th
        // failed attempt's backoff window elapses.
        const past = new Date(Date.now() - 1_000).toISOString();
        const { error: bumpErr } = await ledgerLeaseReader()
          .from("task_calendar_mutations")
          .update({ attempts: 5, next_attempt_at: past })
          .eq("id", ledgerId);
        expect(bumpErr).toBeNull();

        const { data: expireRows, error: expireErr } =
          await expireExhaustedCalendarCreations(serviceClient);
        expect(expireErr).toBeNull();
        expect(expireRows![0].failed_count).toBeGreaterThanOrEqual(1);
        expect(expireRows![0].needs_repair_count).toBe(0);

        const { data: ledgerAfter } = await ledgerLeaseReader()
          .from("task_calendar_mutations")
          .select("phase, attempts, next_attempt_at")
          .eq("id", ledgerId)
          .single();
        expect(ledgerAfter?.phase).toBe("failed");

        // Chain slot freed: idx_task_calendar_mutations_chain_serialization
        // only excludes 'failed'/'provider_done'/'pending' (round 7 adds
        // 'needs_repair'), so once this row terminalizes to 'failed', a
        // fresh pending/provider_done row on the SAME chain no longer
        // collides with it — proving the exhaustion sweep is what
        // actually frees PR 3's lifecycle mutations, not just the
        // attempts<5 claim filter.
        const { error: insertErr } = await ledgerLeaseReader(db)
          .from("task_calendar_mutations")
          .insert({
            org_id: BMH_ORG_ID,
            calendar_chain_id: booking!.calendar_chain_id,
            operation: "reschedule",
            phase: "pending",
            source_task_id: booking!.task_id,
            old_assignee_id: assignee.userId,
            expected_generation: 0,
          });
        expect(insertErr).toBeNull();
      });

      it("terminalizes an exhausted provider_done row to phase='needs_repair' (a repair state, not abandonment) and KEEPS the chain-serialization slot held", async () => {
        const booker = await createUserForOrg(BMH_ORG_ID);
        const assignee = await createUserForOrg(BMH_ORG_ID);
        const { p_start, p_end } = windowArgs();

        const { data: booking, error: bookErr } = await bookAppointment(booker.client, {
          p_org: BMH_ORG_ID,
          p_assignee: assignee.userId,
          p_start,
          p_end,
          p_timezone: "America/Chicago",
          p_title: "Provider-done exhaustion probe",
        });
        expect(bookErr).toBeNull();

        const { data: ledgerBefore } = await db
          .from("task_calendar_mutations")
          .select("id")
          .eq("source_task_id", booking!.task_id)
          .single();
        const ledgerId = (ledgerBefore as { id: string }).id;

        // The Google event WAS created (phase='provider_done') but local
        // finalize kept failing until attempts hit the cap — this is NOT
        // a clean abandonment, unlike a 'pending' exhaustion above.
        const past = new Date(Date.now() - 1_000).toISOString();
        const { error: bumpErr } = await ledgerLeaseReader()
          .from("task_calendar_mutations")
          .update({ phase: "provider_done", attempts: 5, next_attempt_at: past })
          .eq("id", ledgerId);
        expect(bumpErr).toBeNull();

        const { data: expireRows, error: expireErr } =
          await expireExhaustedCalendarCreations(serviceClient);
        expect(expireErr).toBeNull();
        expect(expireRows![0].needs_repair_count).toBeGreaterThanOrEqual(1);

        const { data: ledgerAfter } = await ledgerLeaseReader()
          .from("task_calendar_mutations")
          .select("phase, attempts, next_attempt_at")
          .eq("id", ledgerId)
          .single();
        expect(ledgerAfter?.phase).toBe("needs_repair");

        // Chain slot still held: unlike 'failed', 'needs_repair' remains
        // inside idx_task_calendar_mutations_chain_serialization's WHERE
        // clause — an unreconciled Google event must not be raced by a
        // later lifecycle mutation on the same chain, so this insert must
        // fail with the same unique-violation a live 'pending'/
        // 'provider_done' row would produce.
        const { error: insertErr } = await ledgerLeaseReader(db)
          .from("task_calendar_mutations")
          .insert({
            org_id: BMH_ORG_ID,
            calendar_chain_id: booking!.calendar_chain_id,
            operation: "reschedule",
            phase: "pending",
            source_task_id: booking!.task_id,
            old_assignee_id: assignee.userId,
            expected_generation: 0,
          });
        expect(insertErr).not.toBeNull();
      });

      it("does not touch a row still within its lease window even at attempts>=5", async () => {
        const booker = await createUserForOrg(BMH_ORG_ID);
        const assignee = await createUserForOrg(BMH_ORG_ID);
        const { p_start, p_end } = windowArgs();

        const { data: booking, error: bookErr } = await bookAppointment(booker.client, {
          p_org: BMH_ORG_ID,
          p_assignee: assignee.userId,
          p_start,
          p_end,
          p_timezone: "America/Chicago",
          p_title: "In-flight exhaustion probe",
        });
        expect(bookErr).toBeNull();

        const { data: ledgerBefore } = await db
          .from("task_calendar_mutations")
          .select("id")
          .eq("source_task_id", booking!.task_id)
          .single();
        const ledgerId = (ledgerBefore as { id: string }).id;

        const future = new Date(Date.now() + 5 * 60_000).toISOString();
        const { error: bumpErr } = await ledgerLeaseReader()
          .from("task_calendar_mutations")
          .update({ attempts: 5, next_attempt_at: future })
          .eq("id", ledgerId);
        expect(bumpErr).toBeNull();

        await expireExhaustedCalendarCreations(serviceClient);

        const { data: ledgerAfter } = await ledgerLeaseReader()
          .from("task_calendar_mutations")
          .select("phase, attempts, next_attempt_at")
          .eq("id", ledgerId)
          .single();
        // Still 'pending' — the worker holding this row's in-flight lease
        // gets to finish before the exhaustion sweep would terminalize it.
        expect(ledgerAfter?.phase).toBe("pending");
      });
    });

    // The Supabase JS client auto-commits every PostgREST call, so proving
    // FOR UPDATE SKIP LOCKED actually prevents a double-claim (rather than
    // just never happening to race in this environment) needs two raw `pg`
    // connections: one holds the claimed row locked inside an open,
    // uncommitted transaction while the other calls the same claim RPC
    // concurrently and must come back empty instead of blocking or
    // double-claiming.
    describe("SKIP LOCKED — no double-claim (raw pg, two connections)", () => {
      let connA: Client;
      let connB: Client;

      beforeEach(async () => {
        connA = new Client({ connectionString: testDbUrl() });
        connB = new Client({ connectionString: testDbUrl() });
        await connA.connect();
        await connB.connect();
        await connA.query("set statement_timeout = 0");
        await connB.query("set statement_timeout = 0");
      });

      afterEach(async () => {
        await connA.query("rollback").catch(() => {});
        await connB.query("rollback").catch(() => {});
        await connA.end().catch(() => {});
        await connB.end().catch(() => {});
      });

      it("connB's concurrent claim skips the row connA is still holding, returning empty rather than blocking or duplicating", async () => {
        const booker = await createUserForOrg(BMH_ORG_ID);
        const assignee = await createUserForOrg(BMH_ORG_ID);
        const { p_start, p_end } = windowArgs();

        const { data: booking, error: bookErr } = await bookAppointment(booker.client, {
          p_org: BMH_ORG_ID,
          p_assignee: assignee.userId,
          p_start,
          p_end,
          p_timezone: "America/Chicago",
          p_title: "SKIP LOCKED probe",
        });
        expect(bookErr).toBeNull();

        await connA.query("begin");
        const resA = await connA.query<{
          ledger_id: string;
          source_task_id: string;
        }>("select * from public.fn_claim_calendar_creations($1) as t", [1]);
        const claimedByA = resA.rows.find((r) => r.source_task_id === booking!.task_id);
        expect(claimedByA).toBeDefined();

        // connA holds the row lock open (uncommitted) — connB's SKIP LOCKED
        // claim must skip it and return immediately, not block.
        const resB = await connB.query<{ source_task_id: string }>(
          "select * from public.fn_claim_calendar_creations($1) as t",
          [50],
        );
        expect(resB.rows.some((r) => r.source_task_id === booking!.task_id)).toBe(false);

        await connA.query("commit");

        const { data: ledgerRow } = await db
          .from("task_calendar_mutations")
          .select("attempts")
          .eq("id", claimedByA!.ledger_id)
          .single();
        // Exactly one claim (connA's) landed — attempts bumped once, not twice.
        expect((ledgerRow as { attempts: number }).attempts).toBe(1);

        // Now that connA has committed, the row is no longer lock-held —
        // proving the LEASE (not just the row lock connB raced against
        // above) is what keeps it from being reclaimed. Without
        // next_attempt_at, this claim would succeed immediately.
        const { data: afterCommit, error: afterCommitErr } = await claimCalendarCreations(
          serviceClient,
          50,
        );
        expect(afterCommitErr).toBeNull();
        expect(
          afterCommit!.some((row) => row.ledger_id === claimedByA!.ledger_id),
        ).toBe(false);
      });
    });
  });
});
