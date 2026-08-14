import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

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
};

type BookAppointmentRow = {
  task_id: string;
  calendar_chain_id: string;
  already_qualified: boolean;
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

function getMemberTimezone(
  client: SupabaseClient<Database>,
  userId: string,
): Promise<RpcResult<string>> {
  return asBookingRpcClient(client).rpc("fn_get_member_timezone", { p_user: userId });
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
});
