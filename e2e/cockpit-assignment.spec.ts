import { expect, test } from "@playwright/test";

import {
  adminClient,
  ensureTestUser,
  resetTenantTables,
  seedProspects,
} from "./fixtures";

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
): Promise<{ contactId: string; propertyId: string }> {
  const { data: contact } = await admin
    .from("contacts")
    .insert({
      first_name: "Assign",
      last_name: "Test",
      phone_1: opts.phone,
    })
    .select("id")
    .single();
  if (!contact) throw new Error("contact seed failed");
  const [prop] = await seedProspects(admin, 1, opts.addressTag);
  await admin
    .from("properties")
    .update({
      homeowner_contact_id: contact.id,
      assigned_user_id: opts.assigneeId ?? null,
      status: "new_lead",
    })
    .eq("id", prop.id);
  await admin.from("messages").insert({
    channel: "sms",
    direction: "inbound",
    status: "received",
    contact_id: contact.id,
    property_id: prop.id,
    from_address: opts.phone,
    to_address: "+18162804181",
    body: opts.body ?? "thread for assignment test",
    created_at: new Date(Date.now() + (opts.offsetMin ?? -10) * 60_000).toISOString(),
  });
  return { contactId: contact.id, propertyId: prop.id };
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
  const row = page.getByTestId(`inbox-thread-${mine.contactId}`);
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("data-assignee-mine", "true");
});

test('Side panel shows "Assign to me" on an unassigned thread; clicking it assigns', async ({
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

  await page.goto(`/messages?thread=${unassigned.contactId}`);
  await expect(page.getByTestId("inbox-detail-panel")).toBeVisible();

  const assignToMe = page.getByTestId("assign-to-me");
  await expect(assignToMe).toBeVisible();
  await assignToMe.click();

  await expect(async () => {
    const { data: p } = await admin
      .from("properties")
      .select("assigned_user_id")
      .eq("id", unassigned.propertyId)
      .single();
    expect(p!.assigned_user_id).toBe(claudeId);
  }).toPass({ timeout: 5_000 });

  // After assignment, the pill is replaced by the dropdown trigger.
  await expect(page.getByTestId("assign-to-me")).toHaveCount(0);
  await expect(
    page.getByTestId("assign-dropdown-trigger"),
  ).toBeVisible();
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

  await page.goto(`/messages?thread=${mine.contactId}`);

  const trigger = page.getByTestId("assign-dropdown-trigger");
  await expect(trigger).toBeVisible();
  await trigger.click();
  await page.getByTestId("assign-dropdown-unassign").click();

  await expect(async () => {
    const { data: p } = await admin
      .from("properties")
      .select("assigned_user_id")
      .eq("id", mine.propertyId)
      .single();
    expect(p!.assigned_user_id).toBeNull();
  }).toPass({ timeout: 5_000 });

  // After unassign, the "Assign to me" pill comes back.
  await expect(page.getByTestId("assign-to-me")).toBeVisible();
});
