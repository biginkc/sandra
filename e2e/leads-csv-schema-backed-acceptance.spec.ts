import { expect, test, type Page } from "@playwright/test";

import { adminClient, resetTenantTables } from "./fixtures";

const DEFAULT_ORG_ID = "00000000-0000-0000-0000-000000000bbb";

async function selectOption(
  page: Page,
  placeholder: RegExp,
  option: string,
): Promise<void> {
  await page.getByRole("combobox").filter({ hasText: placeholder }).click();
  await page.getByRole("option", { name: option }).click();
}

test("schema-backed Prospects safety and CSV review work at desktop and narrow widths", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const admin = adminClient();
  await resetTenantTables(admin);

  const { data: contacts, error: contactError } = await admin
    .from("contacts")
    .insert([
      {
        org_id: DEFAULT_ORG_ID,
        first_name: "Permanent",
        last_name: "DNC",
        do_not_contact: true,
        sms_opted_out: false,
      },
      {
        org_id: DEFAULT_ORG_ID,
        first_name: "SMS",
        last_name: "Prospect",
        do_not_contact: false,
        sms_opted_out: true,
      },
      {
        org_id: DEFAULT_ORG_ID,
        first_name: "SMS",
        last_name: "Lead",
        do_not_contact: false,
        sms_opted_out: true,
      },
    ])
    .select("id, first_name, last_name");
  if (contactError || !contacts) {
    throw contactError ?? new Error("contact seed failed");
  }
  const dncContact = contacts.find(
    (contact) => contact.first_name === "Permanent",
  );
  const smsProspectContact = contacts.find(
    (contact) => contact.last_name === "Prospect",
  );
  const smsLeadContact = contacts.find(
    (contact) => contact.last_name === "Lead",
  );
  if (!dncContact || !smsProspectContact || !smsLeadContact) {
    throw new Error("contact seed incomplete");
  }

  const { error: propertyError } = await admin.from("properties").insert([
    {
      org_id: DEFAULT_ORG_ID,
      address: "101 Permanent DNC Way",
      city: "Kansas City",
      state: "MO",
      zip: "64111",
      status: "interested",
      homeowner_contact_id: dncContact.id,
      is_dnc_locked: true,
    },
    {
      org_id: DEFAULT_ORG_ID,
      address: "202 SMS Only Ave",
      city: "Kansas City",
      state: "MO",
      zip: "64111",
      status: "prospect",
      homeowner_contact_id: smsProspectContact.id,
      outreach_dispo: "opted_out",
      is_dnc_locked: false,
    },
    {
      org_id: DEFAULT_ORG_ID,
      address: "303 SMS Only Lead Blvd",
      city: "Kansas City",
      state: "MO",
      zip: "64111",
      status: "new_lead",
      homeowner_contact_id: smsLeadContact.id,
      outreach_dispo: null,
      is_dnc_locked: false,
    },
  ]);
  if (propertyError) throw propertyError;

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/leads");
  await expect(page.getByRole("heading", { name: "Leads" })).toBeVisible();
  await expect(page.getByText("101 Permanent DNC Way")).toHaveCount(0);
  await expect(page.getByText("303 SMS Only Lead Blvd")).toBeVisible();
  await expect(page.getByText("SMS opted out", { exact: true })).toBeVisible();
  await expect(page.getByLabel("1 matching, 1 total")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "No next action 1" }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("schema-backed-leads-dnc-sms-desktop.png"),
    fullPage: true,
    // The default screenshot mode temporarily injects caret-color while
    // React may still be hydrating this input, which creates a false
    // hydration warning in CI. Preserve the real caret instead.
    caret: "initial",
  });

  await page.goto("/properties");
  await expect(page.getByRole("heading", { name: "Prospects" })).toBeVisible();
  await expect(page.getByText("101 Permanent DNC Way")).toBeVisible();
  await expect(page.getByText("⊘ DO NOT CONTACT")).toBeVisible();
  await expect(
    page.getByLabel("101 Permanent DNC Way is locked Do Not Contact"),
  ).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: "Select 101 Permanent DNC Way" }),
  ).toHaveCount(0);
  await expect(page.getByText("202 SMS Only Ave")).toBeVisible();
  await expect(page.getByText("SMS opted out")).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: "Select 202 SMS Only Ave" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Import prospects" }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("schema-backed-prospects-desktop.png"),
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("prospects-table-container")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("schema-backed-prospects-narrow.png"),
    fullPage: true,
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("link", { name: "Import prospects" }).click();
  await expect(
    page.getByRole("heading", { name: "Import prospects" }),
  ).toBeVisible();
  await page.getByTestId("mode-add").click();
  await page.getByRole("button", { name: "Next", exact: true }).click();

  const csv = [
    "Address,City,State,Zip,First Name,Last Name",
    "303 Browser Import St,Kansas City,MO,64111,Jamie,Synthetic",
    "404 Browser Import Ave,Kansas City,MO,64111,Casey,Synthetic",
  ].join("\n");
  await page.locator('input[type="file"]#file').setInputFiles({
    name: "schema-backed-browser-import.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv, "utf8"),
  });
  await expect(
    page.getByText("schema-backed-browser-import.csv", { exact: true }),
  ).toBeVisible();
  await selectOption(page, /pick a source/i, "Direct mail");
  await selectOption(page, /pick a market/i, "Jackson County MO");

  await page.getByRole("button", { name: "Run preflight check" }).click();
  await expect(page.getByText("Preflight check", { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText("Total rows").locator("..")).toContainText("2");
  await page.screenshot({
    path: testInfo.outputPath("schema-backed-import-preflight.png"),
    fullPage: true,
  });

  await page.getByRole("button", { name: "Map columns" }).click();
  await expect(page.getByText("Map columns", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Review rows" }).click();
  await expect(page.getByText("Review rows", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Optional services" }).click();
  await expect(
    page.getByText("Optional services", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("schema-backed-import-services.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Final confirmation" }).click();
  await expect(
    page.getByText(/Review the exact dataset and choices/i),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Import prospects" }),
  ).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: testInfo.outputPath("schema-backed-import-confirm-narrow.png"),
    fullPage: true,
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Import prospects" }).click();
  await expect(
    page.getByText(/Queued|Processing|Completed|Partially completed/).first(),
  ).toBeVisible({ timeout: 20_000 });

  await expect
    .poll(
      async () => {
        const { data, error } = await admin
          .from("csv_imports")
          .select("id")
          .eq("filename", "schema-backed-browser-import.csv")
          .maybeSingle();
        if (error) throw error;
        return data?.id ?? null;
      },
      { timeout: 20_000 },
    )
    .not.toBeNull();

  const { data: importRow, error: importRowError } = await admin
    .from("csv_imports")
    .select("id")
    .eq("filename", "schema-backed-browser-import.csv")
    .single();
  if (importRowError) throw importRowError;
  await expect
    .poll(
      async () => {
        const { data, error } = await admin
          .from("jobs")
          .select("status")
          .eq("related_import_id", importRow.id)
          .maybeSingle();
        if (error) throw error;
        return data?.status ?? null;
      },
      { timeout: 60_000 },
    )
    .toBe("completed");
  await expect
    .poll(
      async () => {
        const { count, error } = await admin
          .from("properties")
          .select("id", { count: "exact", head: true })
          .eq("source_import_id", importRow.id);
        if (error) throw error;
        return count ?? 0;
      },
      { timeout: 20_000 },
    )
    .toBe(2);
  await expect(page.getByText("Completed", { exact: true })).toBeVisible({
    timeout: 20_000,
  });

  await page.screenshot({
    path: testInfo.outputPath("schema-backed-import-started.png"),
    fullPage: true,
  });

  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});
