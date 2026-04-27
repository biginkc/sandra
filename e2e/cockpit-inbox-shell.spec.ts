import { expect, test } from "@playwright/test";

import {
  adminClient,
  ensureTestUser,
  resetTenantTables,
  seedProspects,
} from "./fixtures";

/**
 * Feature 8 Phase 1 — cockpit shell + tabs + inbox list rendering.
 * These specs verify the surface is present and behaves; deeper flows
 * (selection, reply, realtime) live in sibling spec files.
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
): Promise<{ contactId: string; propertyId: string }> {
  const { data: contact } = await admin
    .from("contacts")
    .insert({
      first_name: opts.contactName.first,
      last_name: opts.contactName.last,
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
  return { contactId: contact.id, propertyId: prop.id };
}

test("messages page defaults to Inbox tab (test 7)", async ({ page }) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  await ensureTestUser(admin);

  await page.goto("/messages");
  // Base UI tabs expose active state via aria-selected — that's stable
  // across Base UI versions; data-active is rendered without a value.
  await expect(page.getByTestId("tab-inbox")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByTestId("tab-outbox")).toHaveAttribute(
    "aria-selected",
    "false",
  );
});

test("clicking Outbox switches tabs and renders the queue panel (test 8)", async ({
  page,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  await ensureTestUser(admin);

  await page.goto("/messages");
  await page.getByTestId("tab-outbox").click();
  await expect(page.getByTestId("tab-outbox")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  // QueuePanel renders its table even when empty.
  await expect(page.getByText(/Queued|queued/).first()).toBeVisible();
});

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
    page.getByTestId(`inbox-thread-${old.contactId}`),
  ).toBeVisible();
  await expect(
    page.getByTestId(`inbox-thread-${newer.contactId}`),
  ).toBeVisible();

  // Each row shows: name, preview body, unread badge, timestamp ("ago").
  const newerRow = page.getByTestId(`inbox-thread-${newer.contactId}`);
  await expect(newerRow).toContainText("Newer Thread");
  await expect(newerRow).toContainText("fresh inbound reply");
  await expect(
    page.getByTestId(`inbox-thread-${newer.contactId}-unread`),
  ).toBeVisible();

  // Newer row appears before older in DOM order.
  const list = page.getByTestId("inbox-thread-list");
  const buttons = list.locator("button");
  const firstId = await buttons.first().getAttribute("data-testid");
  expect(firstId).toBe(`inbox-thread-${newer.contactId}`);
});

test("Outbox cadence controls render (regression guard, test 13)", async ({
  page,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  await ensureTestUser(admin);

  await page.goto("/messages?tab=outbox");
  // Auto-send toggle exists. Older copy: "Auto-send" / "Cadence" labels live
  // in queue-panel.tsx — we check for either to avoid coupling to copy.
  const cadenceVisible = await page
    .getByText(/Auto.send|Cadence|Send next/i)
    .first()
    .isVisible()
    .catch(() => false);
  expect(cadenceVisible).toBe(true);
});
