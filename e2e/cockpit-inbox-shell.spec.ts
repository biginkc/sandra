import { expect, test } from "@playwright/test";

import {
  adminClient,
  ensureTestUser,
  resetTenantTables,
  seedProspects,
} from "./fixtures";

/**
 * Feature 8 Phase 1 — cockpit shell + tabs + inbox list rendering.
 *
 * Tests 7, 8, and 13 (default tab, Outbox click → router.replace, cadence
 * controls render) migrated to RTL in
 * `src/app/(dashboard)/messages/cockpit-shell.test.tsx`. The remaining
 * tests cover URL round-trip behavior and DB-driven thread sorting that
 * RTL with mocked routers can't faithfully exercise.
 */

async function seedThread(
  admin: ReturnType<typeof adminClient>,
  opts: {
    phone: string;
    addressTag: string;
    contactName: { first: string; last: string };
    messages: Array<{
      direction: "inbound" | "outbound";
      body: string;
      createdAtOffsetMin: number;
      read?: boolean;
    }>;
  },
): Promise<{ contactId: string; propertyId: string; threadId: string }> {
  const { data: contact } = await admin
    .from("contacts")
    .insert({
      first_name: opts.contactName.first,
      last_name: opts.contactName.last,
      phone_1: opts.phone,
      phone_1_type: "mobile",
    })
    .select("id")
    .single();
  if (!contact) throw new Error("contact seed failed");

  const [prop] = await seedProspects(admin, 1, opts.addressTag);
  await admin
    .from("properties")
    .update({
      homeowner_contact_id: contact.id,
      status: "new_lead",
    })
    .eq("id", prop.id);

  for (const m of opts.messages) {
    const offsetMs = m.createdAtOffsetMin * 60_000;
    const createdAt = new Date(Date.now() + offsetMs).toISOString();
    await admin.from("messages").insert({
      channel: "sms",
      direction: m.direction,
      status: m.direction === "inbound" ? "received" : "sent",
      contact_id: contact.id,
      property_id: prop.id,
      from_address: m.direction === "inbound" ? opts.phone : "+18162804181",
      to_address: m.direction === "inbound" ? "+18162804181" : opts.phone,
      body: m.body,
      created_at: createdAt,
      read_at:
        m.direction === "inbound" && m.read === true
          ? new Date().toISOString()
          : null,
    });
  }
  return {
    contactId: contact.id,
    propertyId: prop.id,
    threadId: `legacy:${contact.id}:${prop.id}`,
  };
}

test("switching tabs preserves URL state (test 9)", async ({ page }) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  await ensureTestUser(admin);

  await page.goto("/messages");
  await page.getByTestId("tab-outbox").click();
  await page.waitForURL(/\?tab=outbox/);
  await page.getByTestId("tab-inbox").click();
  await page.waitForURL(/\/messages(?!\?tab=outbox)/);
});

test("empty inbox shows the empty-state placeholder (test 10)", async ({
  page,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  await ensureTestUser(admin);

  await page.goto("/messages");
  await expect(page.getByTestId("inbox-empty")).toBeVisible();
});

test("seeded threads render sorted by most recent activity (tests 11 + 12)", async ({
  page,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  await ensureTestUser(admin);

  const old = await seedThread(admin, {
    phone: "+18165557011",
    addressTag: "SHELL-OLD",
    contactName: { first: "Old", last: "Thread" },
    messages: [
      { direction: "inbound", body: "old reply", createdAtOffsetMin: -180 },
    ],
  });
  const newer = await seedThread(admin, {
    phone: "+18165557012",
    addressTag: "SHELL-NEW",
    contactName: { first: "Newer", last: "Thread" },
    messages: [
      {
        direction: "inbound",
        body: "fresh inbound reply",
        createdAtOffsetMin: -10,
      },
    ],
  });

  await page.goto("/messages");

  // Both threads render.
  await expect(
    page.getByTestId(`inbox-thread-${old.threadId}`),
  ).toBeVisible();
  await expect(
    page.getByTestId(`inbox-thread-${newer.threadId}`),
  ).toBeVisible();

  // Each row shows: name, preview body, unread badge, timestamp ("ago").
  const newerRow = page.getByTestId(`inbox-thread-${newer.threadId}`);
  await expect(newerRow).toContainText("Newer Thread");
  await expect(newerRow).toContainText("fresh inbound reply");
  await expect(
    page.getByTestId(`inbox-thread-${newer.threadId}-unread`),
  ).toBeVisible();

  // Newer row appears before older in DOM order.
  const list = page.getByTestId("inbox-thread-list");
  const buttons = list.locator("button");
  const firstId = await buttons.first().getAttribute("data-testid");
  expect(firstId).toBe(`inbox-thread-${newer.threadId}`);
});
