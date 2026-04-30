import { expect, test } from "@playwright/test";

import {
  adminClient,
  ensureTestUser,
  resetTenantTables,
  seedProspects,
} from "./fixtures";

/**
 * Feature 8 Phase 1 — selection + thread side-panel rendering.
 *
 * Most of this file's tests migrated to RTL in
 * `src/app/(dashboard)/messages/inbox-detail.test.tsx` (panel renders +
 * bubble colors, ESC closes, switching threads). The single test that
 * remains here exercises a server-action side-effect (`read_at` stamp on
 * inbound rows) and needs the real backend round-trip.
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
