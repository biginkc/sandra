import { expect, test } from "@playwright/test";

import {
  adminClient,
  ensureTestUser,
  resetTenantTables,
  seedProspects,
} from "./fixtures";
import { clickMenuItemByTestId } from "./menu-helpers";

/**
 * Feature 8 Phase 2.5 — Triage UX polish:
 *   - Triage dropdown rewrite (Merge contact / Merge property / Create new lead / Dismiss)
 *   - "View thread" affordance opens read-only modal
 *   - Role toggle (Homeowner / Agent) on flows that create new contacts
 *   - Property merge flow with role-aware FK + detail-row creation
 */

async function seedUnknown(
  admin: ReturnType<typeof adminClient>,
  opts: { from: string; body: string; offsetMin?: number },
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
    })
    .select("id")
    .single();
  if (error) throw error;
  return data!.id;
}

test("Triage dropdown shows the renamed 3 primary options + dismiss after the divider", async ({
  page,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  await ensureTestUser(admin);

  const phone = "+18165561001";
  await seedUnknown(admin, { from: phone, body: "drop test" });

  await page.goto("/messages?filter=unknown");
  await page.getByTestId(`unknown-actions-${phone}`).click();
  await expect(page.getByTestId(`unknown-match-${phone}`)).toBeVisible({
    timeout: 10_000,
  });

  // The four items in the renamed order.
  await expect(
    page.getByTestId(`unknown-match-${phone}`),
  ).toContainText("Merge with existing contact");
  await expect(
    page.getByTestId(`unknown-merge-property-${phone}`),
  ).toContainText("Merge with existing property");
  await expect(
    page.getByTestId(`unknown-create-${phone}`),
  ).toContainText("Create new lead");
  await expect(
    page.getByTestId(`unknown-dismiss-${phone}`),
  ).toContainText("Dismiss");
});

test("View thread affordance opens a read-only thread dialog", async ({
  page,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  await ensureTestUser(admin);

  const phone = "+18165561002";
  await seedUnknown(admin, { from: phone, body: "first body", offsetMin: -60 });
  await seedUnknown(admin, { from: phone, body: "second body", offsetMin: -30 });
  await seedUnknown(admin, { from: phone, body: "third body", offsetMin: -10 });

  await page.goto("/messages?filter=unknown");
  await page.getByTestId(`unknown-view-thread-${phone}`).click();

  const dialog = page.getByTestId("unknown-thread-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("first body");
  await expect(dialog).toContainText("second body");
  await expect(dialog).toContainText("third body");

  // No triage actions inside (the dialog is read-only).
  await expect(
    dialog.getByRole("button", { name: /Merge|Create|Dismiss/i }),
  ).toHaveCount(0);
});

test("Merge with existing contact (renamed) still attaches messages + adds phone_2", async ({
  page,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  await ensureTestUser(admin);

  const phone = "+18165561003";
  await seedUnknown(admin, { from: phone, body: "merge me" });

  const { data: contact } = await admin
    .from("contacts")
    .insert({
      first_name: "Existing",
      last_name: "Person",
      phone_1: "+18165561103",
      phone_1_type: "mobile",
    })
    .select("id")
    .single();
  const [prop] = await seedProspects(admin, 1, "MERGE-CONTACT");
  await admin
    .from("properties")
    .update({ homeowner_contact_id: contact!.id, status: "new_lead" })
    .eq("id", prop.id);

  await page.goto("/messages?filter=unknown");
  await clickMenuItemByTestId(
    page,
    `unknown-actions-${phone}`,
    `unknown-match-${phone}`,
  );
  await page.getByTestId("match-search-input").fill("Existing");
  await expect(page.getByTestId(`match-result-${contact!.id}`)).toBeVisible({
    timeout: 10_000,
  });
  await page.getByTestId(`match-result-${contact!.id}`).click();

  await expect(async () => {
    const { data: c } = await admin
      .from("contacts")
      .select("phone_1, phone_2")
      .eq("id", contact!.id)
      .single();
    expect(c!.phone_2).toBe(phone);
    const { data: msgs } = await admin
      .from("messages")
      .select("contact_id")
      .eq("from_address", phone);
    expect(msgs![0].contact_id).toBe(contact!.id);
  }).toPass({ timeout: 10_000 });
});

test("Merge with existing property — Homeowner role: links homeowner_contact_id, creates homeowner_details", async ({
  page,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  await ensureTestUser(admin);

  const phone = "+18165561004";
  await seedUnknown(admin, { from: phone, body: "merge to prop as homeowner" });

  const [prop] = await seedProspects(admin, 1, "MERGE-PROP-HO");

  await page.goto("/messages?filter=unknown");
  await clickMenuItemByTestId(
    page,
    `unknown-actions-${phone}`,
    `unknown-merge-property-${phone}`,
  );

  await page.getByTestId("merge-property-search-input").fill(prop.address.slice(0, 12));
  await expect(
    page.getByTestId(`merge-property-result-${prop.id}`),
  ).toBeVisible({ timeout: 10_000 });
  await page.getByTestId(`merge-property-result-${prop.id}`).click();

  await page.getByTestId("merge-property-role-homeowner").click();
  await page.getByTestId("merge-property-first").fill("Merged");
  await page.getByTestId("merge-property-last").fill("Owner");
  await page.getByTestId("merge-property-submit").click();

  await expect(async () => {
    const { data: p } = await admin
      .from("properties")
      .select("homeowner_contact_id, agent_contact_id")
      .eq("id", prop.id)
      .single();
    expect(p!.homeowner_contact_id).not.toBeNull();
    expect(p!.agent_contact_id).toBeNull();

    const { data: detail } = await admin
      .from("homeowner_details")
      .select("contact_id")
      .eq("contact_id", p!.homeowner_contact_id!)
      .maybeSingle();
    expect(detail).not.toBeNull();

    const { data: msgs } = await admin
      .from("messages")
      .select("contact_id, property_id")
      .eq("from_address", phone);
    expect(msgs![0].contact_id).toBe(p!.homeowner_contact_id);
    expect(msgs![0].property_id).toBe(prop.id);
  }).toPass({ timeout: 10_000 });
});

test("Merge with existing property — Agent role: links agent_contact_id, creates agent_details", async ({
  page,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  await ensureTestUser(admin);

  const phone = "+18165561005";
  await seedUnknown(admin, { from: phone, body: "merge to prop as agent" });

  const [prop] = await seedProspects(admin, 1, "MERGE-PROP-AG");

  await page.goto("/messages?filter=unknown");
  await clickMenuItemByTestId(
    page,
    `unknown-actions-${phone}`,
    `unknown-merge-property-${phone}`,
  );
  await page.getByTestId("merge-property-search-input").fill(prop.address.slice(0, 12));
  await expect(
    page.getByTestId(`merge-property-result-${prop.id}`),
  ).toBeVisible({ timeout: 10_000 });
  await page.getByTestId(`merge-property-result-${prop.id}`).click();

  await page.getByTestId("merge-property-role-agent").click();
  await page.getByTestId("merge-property-first").fill("Listing");
  await page.getByTestId("merge-property-last").fill("Agent");
  await page.getByTestId("merge-property-submit").click();

  await expect(async () => {
    const { data: p } = await admin
      .from("properties")
      .select("homeowner_contact_id, agent_contact_id")
      .eq("id", prop.id)
      .single();
    expect(p!.homeowner_contact_id).toBeNull();
    expect(p!.agent_contact_id).not.toBeNull();

    const { data: detail } = await admin
      .from("agent_details")
      .select("contact_id")
      .eq("contact_id", p!.agent_contact_id!)
      .maybeSingle();
    expect(detail).not.toBeNull();
  }).toPass({ timeout: 10_000 });
});

test("Create new lead — Homeowner: contact + homeowner_details + property.homeowner_contact_id", async ({
  page,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  await ensureTestUser(admin);

  const phone = "+18165561006";
  await seedUnknown(admin, { from: phone, body: "create new homeowner" });

  await page.goto("/messages?filter=unknown");
  await clickMenuItemByTestId(
    page,
    `unknown-actions-${phone}`,
    `unknown-create-${phone}`,
  );

  await page.getByTestId("role-homeowner").click();
  await page.getByTestId("create-first").fill("Brand");
  await page.getByTestId("create-last").fill("New");
  await page.getByTestId("create-address").fill("123 New Lead Ln");
  await page.getByTestId("create-city").fill("Kansas City");
  await page.getByTestId("create-state").fill("MO");
  await page.getByTestId("create-submit").click();

  await page.waitForURL(/\/leads\/[a-f0-9-]+$/);

  const { data: c } = await admin
    .from("contacts")
    .select("id")
    .eq("phone_1", phone)
    .single();
  expect(c).not.toBeNull();

  const { data: ho } = await admin
    .from("homeowner_details")
    .select("contact_id")
    .eq("contact_id", c!.id)
    .maybeSingle();
  expect(ho).not.toBeNull();

  const { data: p } = await admin
    .from("properties")
    .select("homeowner_contact_id, agent_contact_id")
    .eq("homeowner_contact_id", c!.id)
    .single();
  expect(p!.homeowner_contact_id).toBe(c!.id);
  expect(p!.agent_contact_id).toBeNull();
});

test("Create new lead — Agent: contact + agent_details + property.agent_contact_id", async ({
  page,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  await ensureTestUser(admin);

  const phone = "+18165561007";
  await seedUnknown(admin, { from: phone, body: "create new agent" });

  await page.goto("/messages?filter=unknown");
  await clickMenuItemByTestId(
    page,
    `unknown-actions-${phone}`,
    `unknown-create-${phone}`,
  );

  await page.getByTestId("role-agent").click();
  await page.getByTestId("create-first").fill("Listing");
  await page.getByTestId("create-last").fill("Agent");
  await page.getByTestId("create-address").fill("456 Agent Ave");
  await page.getByTestId("create-state").fill("MO");
  await page.getByTestId("create-submit").click();

  await page.waitForURL(/\/leads\/[a-f0-9-]+$/);

  const { data: c } = await admin
    .from("contacts")
    .select("id")
    .eq("phone_1", phone)
    .single();
  expect(c).not.toBeNull();

  const { data: ag } = await admin
    .from("agent_details")
    .select("contact_id")
    .eq("contact_id", c!.id)
    .maybeSingle();
  expect(ag).not.toBeNull();

  const { data: ho } = await admin
    .from("homeowner_details")
    .select("contact_id")
    .eq("contact_id", c!.id)
    .maybeSingle();
  expect(ho).toBeNull();

  const { data: p } = await admin
    .from("properties")
    .select("homeowner_contact_id, agent_contact_id")
    .eq("agent_contact_id", c!.id)
    .single();
  expect(p!.agent_contact_id).toBe(c!.id);
  expect(p!.homeowner_contact_id).toBeNull();
});
