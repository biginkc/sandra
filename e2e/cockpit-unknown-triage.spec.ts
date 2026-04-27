import { expect, test } from "@playwright/test";

import {
  adminClient,
  ensureTestUser,
  resetTenantTables,
  seedProspects,
} from "./fixtures";

/**
 * Feature 8 Phase 2 — Unknown sender triage. Covers:
 *   - Unknown filter shows unmatched inbounds, grouped by from_address
 *   - Match action attaches messages + adds phone to existing contact
 *   - Create action makes a new contact + property and routes to it
 *   - Dismiss + Restore round-trip
 */

async function seedUnknown(
  admin: ReturnType<typeof adminClient>,
  opts: { from: string; body: string; offsetMin?: number; dismissed?: boolean },
): Promise<string> {
  const offsetMs = (opts.offsetMin ?? 0) * 60_000;
  const { data, error } = await admin
    .from("messages")
    .insert({
      channel: "sms",
      direction: "inbound",
      status: "received",
      contact_id: null,
      property_id: null,
      from_address: opts.from,
      to_address: "+18162804181",
      body: opts.body,
      created_at: new Date(Date.now() + offsetMs).toISOString(),
      dismissed_at: opts.dismissed ? new Date().toISOString() : null,
    })
    .select("id")
    .single();
  if (error) throw error;
  return data!.id;
}

test("Unknown filter shows unmatched senders grouped by from_address", async ({
  page,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  await ensureTestUser(admin);

  await seedUnknown(admin, {
    from: "+18165560001",
    body: "first ping",
    offsetMin: -120,
  });
  await seedUnknown(admin, {
    from: "+18165560001",
    body: "second ping (same sender)",
    offsetMin: -10,
  });
  await seedUnknown(admin, {
    from: "+18165560002",
    body: "different sender",
    offsetMin: -30,
  });

  await page.goto("/messages?filter=unknown");

  const list = page.getByTestId("unknown-sender-list");
  await expect(list).toBeVisible();

  // Both unique senders render (not three rows for the duplicated number).
  await expect(
    page.getByTestId("unknown-row-+18165560001"),
  ).toContainText("second ping (same sender)");
  await expect(
    page.getByTestId("unknown-row-+18165560001"),
  ).toContainText("2 msgs");
  await expect(
    page.getByTestId("unknown-row-+18165560002"),
  ).toContainText("different sender");
});

test("filter chip shows the active unknown count badge", async ({ page }) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  await ensureTestUser(admin);

  await seedUnknown(admin, { from: "+18165560010", body: "a" });
  await seedUnknown(admin, { from: "+18165560011", body: "b" });
  await seedUnknown(admin, {
    from: "+18165560012",
    body: "dismissed",
    dismissed: true,
  });

  await page.goto("/messages");

  // Badge counts only ACTIVE unknown senders (excludes dismissed).
  await expect(page.getByTestId("filter-unknown")).toContainText("2");
});

test("Match flow attaches message + adds phone_2 + backfills siblings", async ({
  page,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  await ensureTestUser(admin);

  const phone = "+18165560020";
  // Two unmatched inbounds from the same number.
  await seedUnknown(admin, { from: phone, body: "msg one", offsetMin: -60 });
  await seedUnknown(admin, { from: phone, body: "msg two", offsetMin: -10 });

  // Existing contact to match against — has phone_1 only.
  const { data: contact } = await admin
    .from("contacts")
    .insert({
      first_name: "Existing",
      last_name: "Match",
      phone_1: "+18165560120",
    })
    .select("id")
    .single();
  if (!contact) throw new Error("contact seed failed");
  const [prop] = await seedProspects(admin, 1, "MATCH");
  await admin
    .from("properties")
    .update({ homeowner_contact_id: contact.id, status: "new_lead" })
    .eq("id", prop.id);

  await page.goto("/messages?filter=unknown");
  await page.getByTestId(`unknown-actions-${phone}`).click();
  await page.getByTestId(`unknown-match-${phone}`).click();

  // Match dialog opens; search by name fragment.
  await page.getByTestId("match-search-input").fill("Existing");
  // Wait for the debounced search and result to appear.
  await expect(page.getByTestId(`match-result-${contact.id}`)).toBeVisible({
    timeout: 5_000,
  });
  await page.getByTestId(`match-result-${contact.id}`).click();

  // DB assertions: both messages now point to the contact, and the
  // phone is in phone_2 (phone_1 was occupied).
  await expect(async () => {
    const { data: msgs } = await admin
      .from("messages")
      .select("contact_id")
      .eq("from_address", phone);
    expect(msgs).toHaveLength(2);
    for (const m of msgs ?? []) {
      expect(m.contact_id).toBe(contact.id);
    }
    const { data: c } = await admin
      .from("contacts")
      .select("phone_1, phone_2")
      .eq("id", contact.id)
      .single();
    expect(c!.phone_1).toBe("+18165560120");
    expect(c!.phone_2).toBe(phone);
  }).toPass({ timeout: 10_000 });

  // After router.refresh, the row should disappear from the Unknown bucket.
  await expect(page.getByTestId(`unknown-row-${phone}`)).toHaveCount(0);
});

test("Create flow makes a new contact + property and routes to the lead", async ({
  page,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  await ensureTestUser(admin);

  const phone = "+18165560030";
  await seedUnknown(admin, { from: phone, body: "fresh inbound" });

  await page.goto("/messages?filter=unknown");
  await page.getByTestId(`unknown-actions-${phone}`).click();
  await page.getByTestId(`unknown-create-${phone}`).click();

  // Phase 2.5 made the role radio (Homeowner / Agent) required. Pick
  // Homeowner to match this test's original intent.
  await page.getByTestId("role-homeowner").click();
  await page.getByTestId("create-first").fill("Brand");
  await page.getByTestId("create-last").fill("New");
  await page.getByTestId("create-address").fill("123 Created Ln");
  await page.getByTestId("create-city").fill("Kansas City");
  await page.getByTestId("create-state").fill("MO");
  await page.getByTestId("create-submit").click();

  // Routes to the new lead.
  await page.waitForURL(/\/leads\/[a-f0-9-]+$/);

  // DB assertions.
  const { data: c } = await admin
    .from("contacts")
    .select("first_name, last_name, phone_1")
    .eq("phone_1", phone)
    .single();
  expect(c).toMatchObject({
    first_name: "Brand",
    last_name: "New",
    phone_1: phone,
  });

  const { data: msg } = await admin
    .from("messages")
    .select("contact_id, property_id")
    .eq("from_address", phone)
    .single();
  expect(msg!.contact_id).not.toBeNull();
  expect(msg!.property_id).not.toBeNull();
});

test("Dismiss removes from Unknown; Restore brings it back", async ({
  page,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  await ensureTestUser(admin);

  const phone = "+18165560040";
  await seedUnknown(admin, { from: phone, body: "dismiss me" });

  await page.goto("/messages?filter=unknown");
  await expect(page.getByTestId(`unknown-row-${phone}`)).toBeVisible();

  // Confirm dialog — auto-accept.
  page.once("dialog", (d) => d.accept());
  await page.getByTestId(`unknown-actions-${phone}`).click();
  await page.getByTestId(`unknown-dismiss-${phone}`).click();

  await expect(page.getByTestId(`unknown-row-${phone}`)).toHaveCount(0);

  // DB stamped.
  await expect(async () => {
    const { data } = await admin
      .from("messages")
      .select("dismissed_at")
      .eq("from_address", phone);
    expect(data).toHaveLength(1);
    expect(data![0].dismissed_at).not.toBeNull();
  }).toPass({ timeout: 5_000 });

  // Switch to Dismissed sub-tab and restore.
  await page.getByTestId("filter-dismissed").click();
  await expect(page.getByTestId(`unknown-row-${phone}`)).toBeVisible();
  await page.getByTestId(`unknown-restore-${phone}`).click();

  await expect(async () => {
    const { data } = await admin
      .from("messages")
      .select("dismissed_at")
      .eq("from_address", phone);
    expect(data![0].dismissed_at).toBeNull();
  }).toPass({ timeout: 5_000 });
});
