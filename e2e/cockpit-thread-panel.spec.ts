import { expect, test } from "@playwright/test";

import {
  adminClient,
  ensureTestUser,
  resetTenantTables,
  seedProspects,
} from "./fixtures";

/**
 * Feature 8 Phase 1 — selection + thread side-panel rendering.
 */

async function seedThread(
  admin: ReturnType<typeof adminClient>,
  opts: {
    phone: string;
    addressTag: string;
    bodies: Array<{ direction: "inbound" | "outbound"; body: string; offsetMin: number; read?: boolean }>;
  },
): Promise<{ contactId: string; propertyId: string }> {
  const { data: contact } = await admin
    .from("contacts")
    .insert({
      first_name: "Panel",
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
      status: "new_lead",
    })
    .eq("id", prop.id);
  for (const m of opts.bodies) {
    await admin.from("messages").insert({
      channel: "sms",
      direction: m.direction,
      status: m.direction === "inbound" ? "received" : "sent",
      contact_id: contact.id,
      property_id: prop.id,
      from_address: m.direction === "inbound" ? opts.phone : "+18162804181",
      to_address: m.direction === "inbound" ? "+18162804181" : opts.phone,
      body: m.body,
      created_at: new Date(Date.now() + m.offsetMin * 60_000).toISOString(),
      read_at:
        m.direction === "inbound" && m.read === true
          ? new Date().toISOString()
          : null,
    });
  }
  return { contactId: contact.id, propertyId: prop.id };
}

test("clicking a thread opens the side panel with conversation bubbles (tests 14 + 15)", async ({
  page,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  await ensureTestUser(admin);

  const { contactId } = await seedThread(admin, {
    phone: "+18165557101",
    addressTag: "PANEL-A",
    bodies: [
      { direction: "outbound", body: "first outbound", offsetMin: -30 },
      { direction: "inbound", body: "first inbound", offsetMin: -20 },
    ],
  });

  await page.goto("/messages");
  await expect(page.getByTestId("inbox-detail-empty")).toBeVisible();

  await page.getByTestId(`inbox-thread-${contactId}`).click();
  await page.waitForURL(new RegExp(`thread=${contactId}`));

  // Panel renders with both bubbles. Outbound has bg-primary, inbound bg-muted.
  const panel = page.getByTestId("inbox-detail-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("first outbound");
  await expect(panel).toContainText("first inbound");

  const outboundBubble = panel.locator(".bg-primary").first();
  const inboundBubble = panel.locator(".bg-muted").first();
  await expect(outboundBubble).toBeVisible();
  await expect(inboundBubble).toBeVisible();
});

test("ESC closes the panel and clears ?thread (test 16)", async ({ page }) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  await ensureTestUser(admin);

  const { contactId } = await seedThread(admin, {
    phone: "+18165557102",
    addressTag: "PANEL-ESC",
    bodies: [{ direction: "inbound", body: "open me", offsetMin: -5 }],
  });

  await page.goto(`/messages?thread=${contactId}`);
  await expect(page.getByTestId("inbox-detail-panel")).toBeVisible();

  await page.keyboard.press("Escape");
  await page.waitForURL(/\/messages(?!.*thread=)/);
  await expect(page.getByTestId("inbox-detail-empty")).toBeVisible();
});

test("clicking another thread updates the panel (test 17)", async ({
  page,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  await ensureTestUser(admin);

  const a = await seedThread(admin, {
    phone: "+18165557103",
    addressTag: "PANEL-A",
    bodies: [{ direction: "inbound", body: "hello from A", offsetMin: -30 }],
  });
  const b = await seedThread(admin, {
    phone: "+18165557104",
    addressTag: "PANEL-B",
    bodies: [{ direction: "inbound", body: "hello from B", offsetMin: -10 }],
  });

  await page.goto("/messages");
  await page.getByTestId(`inbox-thread-${a.contactId}`).click();
  await expect(page.getByTestId("inbox-detail-panel")).toContainText(
    "hello from A",
  );

  await page.getByTestId(`inbox-thread-${b.contactId}`).click();
  await expect(page.getByTestId("inbox-detail-panel")).toContainText(
    "hello from B",
  );
});

test.skip("long thread scrolls to most recent on open (test 18)", async () => {
  // TODO: requires controlling scroll behavior reliably across browsers.
  // Defer to manual QA for now; flake risk too high to gate CI on this.
});

test("opening a thread clears its unread badge (test 19)", async ({ page }) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  await ensureTestUser(admin);

  const { contactId, propertyId } = await seedThread(admin, {
    phone: "+18165557105",
    addressTag: "PANEL-UNREAD",
    bodies: [
      { direction: "inbound", body: "unread 1", offsetMin: -20 },
      { direction: "inbound", body: "unread 2", offsetMin: -10 },
    ],
  });

  await page.goto("/messages");
  await expect(
    page.getByTestId(`inbox-thread-${contactId}-unread`),
  ).toBeVisible();

  await page.getByTestId(`inbox-thread-${contactId}`).click();
  await page.waitForURL(new RegExp(`thread=${contactId}`));

  // Server stamped read_at on those inbound rows when we opened the panel.
  await expect(async () => {
    const { data } = await admin
      .from("messages")
      .select("read_at")
      .eq("property_id", propertyId)
      .eq("direction", "inbound");
    expect(data).toHaveLength(2);
    for (const m of data ?? []) {
      expect(m.read_at).not.toBeNull();
    }
  }).toPass({ timeout: 5_000 });
});
