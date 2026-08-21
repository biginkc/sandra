import { expect, test } from "@playwright/test";

import { adminClient, resetTenantTables, ensureTestUser, seedProspects } from "./fixtures";

test("softphone popover completes a simulated lead call through wrap-up", async ({ page }) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  const userId = await ensureTestUser(admin);
  const contact = await admin.from("contacts").insert({
    org_id: "00000000-0000-0000-0000-000000000bbb",
    first_name: "Softphone",
    last_name: "Happy Path",
    phone_1: "+18165550123",
    phone_1_type: "mobile",
  }).select("id").single();
  expect(contact.error).toBeNull();
  const [property] = await seedProspects(admin, 1, "SOFTPHONE");
  const propertyUpdate = await admin.from("properties").update({
    homeowner_contact_id: contact.data!.id,
    status: "new_lead",
    assigned_user_id: userId,
  }).eq("id", property.id);
  expect(propertyUpdate.error).toBeNull();

  await page.goto("/leads");
  await expect(page.getByTestId("header-dialer-button")).toBeVisible();
  await page.getByTestId("header-dialer-button").click();
  await expect(page.getByTestId("softphone-popover")).toBeVisible();
  await page.getByTestId("dialer-input").fill("Softphone");
  await expect(page.getByTestId("dialer-suggestion")).toHaveCount(1);
  await page.getByTestId("dialer-suggestion").click();
  await expect(page.getByTestId("call-live-pill")).toContainText("Live · browser audio");
  await page.getByTestId("call-hold").click();
  await expect(page.getByTestId("call-live-pill")).toContainText("On hold");
  await page.getByTestId("call-hold").click();
  await page.getByTestId("call-hangup").click();
  await expect(page.getByTestId("dispo-notes")).toBeVisible();
  await expect(page.getByTestId("dispo-offer-discussed")).toHaveCount(0);
  await expect(page.getByTestId("dispo-voicemail")).toHaveCount(0);
  await page.getByTestId("dispo-notes").fill("Simulated call completed during Phase 1.");
  await page.getByTestId("dispo-not-interested").click();
  await expect(page.getByTestId("softphone-popover")).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("Logged");
});

test("manual dialing an exact DNC lead number is refused", async ({ page }) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  await ensureTestUser(admin);
  const contact = await admin.from("contacts").insert({
    org_id: "00000000-0000-0000-0000-000000000bbb",
    first_name: "DNC",
    last_name: "Manual Block",
    phone_1: "+18165550124",
    phone_1_type: "mobile",
    do_not_contact: true,
  }).select("id").single();
  expect(contact.error).toBeNull();
  const [property] = await seedProspects(admin, 1, "SOFTPHONE-DNC");
  const propertyUpdate = await admin.from("properties").update({
    homeowner_contact_id: contact.data!.id,
    status: "new_lead",
    is_dnc_locked: true,
  }).eq("id", property.id);
  expect(propertyUpdate.error).toBeNull();

  await page.goto("/leads");
  await page.getByTestId("header-dialer-button").click();
  await page.getByTestId("dialer-input").fill("8165550124");
  await expect(page.getByTestId("dialer-call-manual")).toBeEnabled();
  await page.getByTestId("dialer-call-manual").click();
  await expect(page.getByRole("alert")).toHaveText("This number belongs to a DNC-locked lead");
  await expect(page.getByTestId("softphone-popover")).toBeVisible();
});
