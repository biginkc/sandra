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
 * Covers:
 *   - Mine + Unassigned chips filter the visible thread list
 *   - Each assigned thread row shows assignee initials
 *   - Side-panel "Assign to me" pill appears on unassigned threads
 *   - Assignee dropdown updates `properties.assigned_user_id`
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

test("Mine chip filters threads to those assigned to the current user", async ({
  page,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  const claudeId = await ensureTestUser(admin);

  // One mine, one for someone else, one unassigned.
  const mine = await seedAssignedThread(admin, {
    phone: "+18165562001",
    addressTag: "MINE",
    assigneeId: claudeId,
    body: "this is mine",
    offsetMin: -5,
  });

  // Mint another user to own the "not mine" thread. Idempotent —
  // re-runs in CI hit the existing row instead of failing on a
  // duplicate-email error.
  const otherEmail = "other-cockpit@example.com";
  const { data: existingUsers } = await admin.auth.admin.listUsers({
    perPage: 200,
  });
  let otherId = existingUsers?.users.find((u) => u.email === otherEmail)?.id;
  if (!otherId) {
    const { data: created } = await admin.auth.admin.createUser({
      email: otherEmail,
      password: "irrelevant",
      email_confirm: true,
    });
    otherId = created?.user?.id;
  }
  if (!otherId) throw new Error("could not create or fetch other user");
  const notMine = await seedAssignedThread(admin, {
    phone: "+18165562002",
    addressTag: "OTHERS",
    assigneeId: otherId,
    body: "belongs to someone else",
    offsetMin: -10,
  });

  const unassigned = await seedAssignedThread(admin, {
    phone: "+18165562003",
    addressTag: "OPEN",
    assigneeId: null,
    body: "claim me",
    offsetMin: -15,
  });

  await page.goto("/messages?filter=mine");
  await expect(page.getByTestId("filter-mine")).toHaveAttribute(
    "data-active",
    "true",
  );

  await expect(
    page.getByTestId(`inbox-thread-${mine.contactId}`),
  ).toBeVisible();
  await expect(
    page.getByTestId(`inbox-thread-${notMine.contactId}`),
  ).toHaveCount(0);
  await expect(
    page.getByTestId(`inbox-thread-${unassigned.contactId}`),
  ).toHaveCount(0);
});

test("Unassigned chip filters threads to those with no assignee", async ({
  page,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  const claudeId = await ensureTestUser(admin);

  const assigned = await seedAssignedThread(admin, {
    phone: "+18165562010",
    addressTag: "ASSIGNED",
    assigneeId: claudeId,
    offsetMin: -5,
  });
  const unassigned = await seedAssignedThread(admin, {
    phone: "+18165562011",
    addressTag: "OPEN",
    assigneeId: null,
    offsetMin: -10,
  });

  await page.goto("/messages?filter=unassigned");
  await expect(page.getByTestId("filter-unassigned")).toHaveAttribute(
    "data-active",
    "true",
  );

  await expect(
    page.getByTestId(`inbox-thread-${unassigned.contactId}`),
  ).toBeVisible();
  await expect(
    page.getByTestId(`inbox-thread-${assigned.contactId}`),
  ).toHaveCount(0);
});

test("Each assigned thread row shows assignee initials avatar", async ({
  page,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  const claudeId = await ensureTestUser(admin);

  const mine = await seedAssignedThread(admin, {
    phone: "+18165562020",
    addressTag: "AVATAR",
    assigneeId: claudeId,
  });

  await page.goto("/messages");
  const avatar = page.getByTestId(`inbox-thread-${mine.contactId}-assignee`);
  await expect(avatar).toBeVisible();
  await expect(avatar).toHaveAttribute("data-assignee-mine", "true");
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
