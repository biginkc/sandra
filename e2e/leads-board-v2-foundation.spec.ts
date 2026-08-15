import { expect, test } from "@playwright/test";

import {
  TEST_USER_EMAIL,
  adminClient,
  resetTenantTables,
} from "./fixtures";

test("Leads board v2 foundation is usable at desktop and narrow widths", async ({
  page,
}, testInfo) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const admin = adminClient();
  await resetTenantTables(admin);

  const { data: users } = await admin.auth.admin.listUsers({ perPage: 200 });
  const currentUser = users.users.find((user) => user.email === TEST_USER_EMAIL);
  expect(currentUser).toBeTruthy();

  const { data: contact, error: contactError } = await admin
    .from("contacts")
    .insert({
      first_name: "Taylor",
      last_name: "Seller",
      phone_1: "+18165550123",
      phone_1_type: "mobile",
    })
    .select("id")
    .single();
  if (contactError || !contact) throw contactError ?? new Error("contact seed failed");

  const { data: property, error: propertyError } = await admin
    .from("properties")
    .insert({
      address: "123 Foundation Ave",
      city: "Kansas City",
      state: "MO",
      zip: "64111",
      market: "Jackson County MO",
      status: "new_lead",
      motivation_level: "hot",
      homeowner_contact_id: contact.id,
      assigned_user_id: currentUser!.id,
    })
    .select("id, org_id")
    .single();
  if (propertyError || !property) {
    throw propertyError ?? new Error("property seed failed");
  }

  const { error: messageError } = await admin.from("messages").insert({
    org_id: property.org_id,
    property_id: property.id,
    contact_id: contact.id,
    channel: "sms",
    direction: "inbound",
    status: "received",
    body: "Can you call me tomorrow?",
    created_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
  });
  if (messageError) throw messageError;

  await page.goto("/leads");
  await expect(page.getByRole("heading", { name: "Leads" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Import CSV/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add lead" })).toBeVisible();
  await expect(page.getByText("Taylor Seller · Kansas City, MO")).toBeVisible();
  await expect(page.getByTestId(`leadcard-last-message-${property.id}`)).toContainText(
    "Them: Can you call me tomorrow? · 3d",
  );

  await expect
    .poll(async () =>
      page
        .getByTestId("leads-board-scroll")
        .locator(":scope > [data-status]")
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-status"))),
    )
    .toEqual([
      "new_lead",
      "contacted",
      "interested",
      "offer_sent",
      "offer_declined",
      "under_contract",
      "closed",
      "dead",
    ]);
  await expect(page.getByRole("button", { name: "Expand Closed" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Expand Dead" })).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "Show all leads or choose a teammate" }),
  ).toHaveValue("all");

  await page.getByRole("button", { name: "Add lead" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByLabel("Street address")).toBeVisible();
  await expect(page.getByLabel("State")).toBeVisible();
  await expect(page.getByLabel("Market")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("leads-add-dialog-desktop.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();

  await page.screenshot({
    path: testInfo.outputPath("leads-board-v2-desktop.png"),
    fullPage: true,
  });

  await page.getByRole("textbox", { name: "Search leads" }).fill("no-such-lead");
  await expect(page.getByText("No leads match these filters")).toBeVisible();
  await expect(page.getByRole("button", { name: /Search: no-such-lead/ })).toBeVisible();
  await page.getByRole("button", { name: "Reset all", exact: true }).click();
  await expect(page.getByText("123 Foundation Ave")).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("leads-board-scroll")).toBeVisible();
  const overflow = await page.getByTestId("leads-board-scroll").evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    pageWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  expect(overflow.scrollWidth).toBeGreaterThan(overflow.clientWidth);
  expect(overflow.pageWidth).toBeLessThanOrEqual(overflow.viewportWidth);

  await page.screenshot({
    path: testInfo.outputPath("leads-board-v2-narrow.png"),
    fullPage: true,
  });

  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});
