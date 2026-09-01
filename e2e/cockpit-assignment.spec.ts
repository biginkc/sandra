import { expect, test } from "@playwright/test";

import {
  adminClient,
  ensureTestUser,
  resetTenantTables,
  seedProspects,
} from "./fixtures";
import { ensureConversationIdForThread } from "../src/lib/messages/threading";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../src/lib/supabase/types";
import { assertBrowserQaProtected, assertIdentity, createIdentity, identityFromEnvironment } from "../src/lib/testing/e2e-identity-policy";

const ASSIGNEE_IDENTITY = process.env.CI === "1"
  ? createIdentity(identityFromEnvironment().runSlug, process.env.E2E_ASSIGNEE_PASSWORD ?? "", "assignee")
  : createIdentity("gha-1-1", "local-development-only-password-000000", "assignee");
const SECONDARY_USER_EMAIL = ASSIGNEE_IDENTITY.email;
const DEFAULT_ORG_ID = "00000000-0000-0000-0000-000000000bbb";
type AuthUser = { id: string; email?: string | null; app_metadata?: unknown };

/**
 * Feature 8 Phase 3 — Per-user assignment + cockpit ergonomics.
 *
 * Mine + Unassigned chip render tests migrated to RTL in
 * `src/app/(dashboard)/messages/inbox-filters.test.tsx`. The remaining
 * tests assert on `properties.assigned_user_id` after a Server Action
 * runs, so they keep the real backend round-trip.
 */

async function seedAssignedThread(
  admin: ReturnType<typeof adminClient>,
  opts: {
    phone: string;
    addressTag: string;
    assigneeId?: string | null;
    body?: string;
    offsetMin?: number;
  },
): Promise<{ contactId: string; propertyId: string; threadId: string }> {
  const { data: contact, error: contactErr } = await admin
    .from("contacts")
    .insert({
      first_name: "Assign",
      last_name: "Test",
      phone_1: opts.phone,
      phone_1_type: "mobile",
    })
    .select("id")
    .single();
  if (contactErr || !contact) {
    throw new Error(`contact seed failed: ${contactErr?.message ?? "no row"}`);
  }
  const [prop] = await seedProspects(admin, 1, opts.addressTag);
  const { error: propertyErr } = await admin
    .from("properties")
    .update({
      homeowner_contact_id: contact.id,
      assigned_user_id: opts.assigneeId ?? null,
      status: "new_lead",
    })
    .eq("id", prop.id);
  if (propertyErr) {
    throw new Error(`property assignment seed failed: ${propertyErr.message}`);
  }
  const conversationId = await ensureConversationIdForThread(
    admin,
    contact.id,
    prop.id,
  );
  const { error: messageErr } = await admin.from("messages").insert({
    channel: "sms",
    direction: "inbound",
    status: "received",
    conversation_id: conversationId,
    contact_id: contact.id,
    property_id: prop.id,
    from_address: opts.phone,
    to_address: "+18162804181",
    body: opts.body ?? "thread for assignment test",
    created_at: new Date(
      Date.now() + (opts.offsetMin ?? -10) * 60_000,
    ).toISOString(),
  });
  if (messageErr) {
    throw new Error(`message seed failed: ${messageErr.message}`);
  }
  const expectedAssigneeId = opts.assigneeId ?? null;
  await expect(async () => {
    const { data, error } = await admin
      .from("properties")
      .select("id, assigned_user_id, homeowner_contact_id, messages!inner(id)")
      .eq("id", prop.id)
      .eq("homeowner_contact_id", contact.id)
      .single();
    expect(error).toBeNull();
    expect(data?.id).toBe(prop.id);
    expect(data?.assigned_user_id).toBe(expectedAssigneeId);
  }).toPass({ timeout: 10_000 });
  return {
    contactId: contact.id,
    propertyId: prop.id,
    threadId: conversationId,
  };
}

async function ensureSecondaryTestUser(
  admin: ReturnType<typeof adminClient>,
): Promise<{ id: string; email: string }> {
  const existing = await findAuthUserByEmail(admin, SECONDARY_USER_EMAIL);
  let userId: string;
  if (existing) {
    assertBrowserQaProtected(existing);
    assertIdentity(existing, ASSIGNEE_IDENTITY);
    userId = existing.id;
  } else {
    const { data: created, error: createErr } =
      await admin.auth.admin.createUser({
        email: SECONDARY_USER_EMAIL,
        password: ASSIGNEE_IDENTITY.password,
        email_confirm: true,
        app_metadata: ASSIGNEE_IDENTITY.appMetadata,
      });
    if (createErr || !created?.user) {
      throw createErr ?? new Error("createUser returned no secondary user");
    }
    assertIdentity(created.user, ASSIGNEE_IDENTITY);
    userId = created.user.id;
  }

  type MembershipWriter = {
    from(table: "memberships"): {
      upsert(
        values: { user_id: string; org_id: string; role: "owner" | "member" },
        options?: { onConflict?: string },
      ): Promise<{ error: { message: string } | null }>;
    };
  };
  const { error: membershipErr } = await (admin as unknown as MembershipWriter)
    .from("memberships")
    .upsert(
      { user_id: userId, org_id: DEFAULT_ORG_ID, role: "member" },
      { onConflict: "user_id,org_id" },
    );
  if (membershipErr) {
    throw new Error(
      `ensureSecondaryTestUser: failed to upsert membership for ${SECONDARY_USER_EMAIL}: ${membershipErr.message}`,
    );
  }

  return { id: userId, email: SECONDARY_USER_EMAIL };
}

async function findAuthUserByEmail(
  admin: SupabaseClient<Database>,
  email: string,
): Promise<AuthUser | null> {
  let page = 1;
  const perPage = 200;

  while (true) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage,
    });
    if (error) throw error;

    const match = data?.users.find((u) => u.email === email);
    if (match) return match;
    if (!data?.nextPage || data.users.length === 0) return null;
    page = data.nextPage;
  }
}

test("Each assigned thread row tags itself with the viewer's assignment state", async ({
  page,
}) => {
  // Was previously asserted on a per-row "assignee initials avatar"
  // shown next to the contact's name. The thread row now uses CONTACT
  // initials in that slot per the messages-cockpit Stitch design;
  // assignment visibility lives in the detail panel ("Assigned: <name>")
  // and on the row button as a data-attribute that the test suite + CSS
  // can key off.
  const admin = adminClient();
  await resetTenantTables(admin);
  const claudeId = await ensureTestUser(admin);

  const mine = await seedAssignedThread(admin, {
    phone: "+18165562020",
    addressTag: "AVATAR",
    assigneeId: claudeId,
  });

  await page.goto("/messages");
  const row = page.getByTestId(`inbox-thread-${mine.threadId}`);
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("data-assignee-mine", "true");
});

test('Side panel shows "No owner" picker on an unassigned thread; choosing Me assigns', async ({
  page,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  const claudeId = await ensureTestUser(admin);

  const unassigned = await seedAssignedThread(admin, {
    phone: "+18165562030",
    addressTag: "TO-ME",
    assigneeId: null,
  });

  await page.goto(`/messages?thread=${encodeURIComponent(unassigned.threadId)}`);
  await expect(page.getByTestId("inbox-detail-panel")).toBeVisible();

  await expect(page.getByTestId("assign-to-me")).toHaveCount(0);
  const trigger = page.getByTestId("assign-dropdown-trigger");
  await expect(trigger).toBeVisible();
  await expect(trigger).toContainText("No owner");
  await trigger.click();

  const selfOption = page.getByTestId("assign-dropdown-me");
  await expect(selfOption).toBeVisible();
  await expect(selfOption).toContainText("Me");
  await expect(page.getByTestId("assign-dropdown-unassign")).toBeVisible();
  await selfOption.click();

  await expect(async () => {
    const { data: p } = await admin
      .from("properties")
      .select("assigned_user_id")
      .eq("id", unassigned.propertyId)
      .single();
    expect(p!.assigned_user_id).toBe(claudeId);
  }).toPass({ timeout: 10_000 });

  await expect(page.getByTestId("assign-to-me")).toHaveCount(0);
  await expect(page.getByTestId("assign-dropdown-trigger")).toContainText(
    "Assigned: me",
  );
});

test("Assignee dropdown can assign a teammate directly from an unassigned thread", async ({
  page,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  await ensureTestUser(admin);
  const teammate = await ensureSecondaryTestUser(admin);

  const unassigned = await seedAssignedThread(admin, {
    phone: "+18165562035",
    addressTag: "TO-TEAMMATE",
    assigneeId: null,
  });

  await page.goto(`/messages?thread=${encodeURIComponent(unassigned.threadId)}`);
  await expect(page.getByTestId("inbox-detail-panel")).toBeVisible();

  const trigger = page.getByTestId("assign-dropdown-trigger");
  await expect(trigger).toBeVisible();
  await expect(trigger).toContainText("No owner");
  await trigger.click();

  const teammateOption = page.getByTestId(
    `assign-dropdown-user-${teammate.id}`,
  );
  await expect(teammateOption).toBeVisible();
  await expect(teammateOption).toContainText(teammate.email);
  await teammateOption.click();

  await expect(async () => {
    const { data: p } = await admin
      .from("properties")
      .select("assigned_user_id")
      .eq("id", unassigned.propertyId)
      .single();
    expect(p!.assigned_user_id).toBe(teammate.id);
  }).toPass({ timeout: 10_000 });
});

test("Assignee dropdown can unassign and reassign via the picker", async ({
  page,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  const claudeId = await ensureTestUser(admin);

  const mine = await seedAssignedThread(admin, {
    phone: "+18165562040",
    addressTag: "REASSIGN",
    assigneeId: claudeId,
  });

  await page.goto(`/messages?thread=${encodeURIComponent(mine.threadId)}`);

  const trigger = page.getByTestId("assign-dropdown-trigger");
  await expect(trigger).toBeVisible();
  await trigger.click();
  const unassign = page.getByTestId("assign-dropdown-unassign");
  await expect(unassign).toBeVisible();
  await unassign.click();

  await expect(async () => {
    const { data: p } = await admin
      .from("properties")
      .select("assigned_user_id")
      .eq("id", mine.propertyId)
      .single();
    expect(p!.assigned_user_id).toBeNull();
  }).toPass({ timeout: 10_000 });

  await expect(page.getByTestId("assign-to-me")).toHaveCount(0);
  await expect(trigger).toBeVisible();
  await expect(trigger).toContainText("No owner");

  await trigger.click();
  await expect(page.getByTestId("assign-dropdown-me")).toBeVisible();
  await page.getByTestId("assign-dropdown-me").click();

  await expect(async () => {
    const { data: p } = await admin
      .from("properties")
      .select("assigned_user_id")
      .eq("id", mine.propertyId)
      .single();
    expect(p!.assigned_user_id).toBe(claudeId);
  }).toPass({ timeout: 10_000 });
});
