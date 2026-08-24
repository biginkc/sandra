import { expect, test } from "@playwright/test";

import {
  adminClient,
  ensureTestUser,
  resetTenantTables,
} from "./fixtures";

const LEADS_TEAMMATE_EMAIL = "e2e-leads-teammate@bmhgroupkc.com";
const DEFAULT_ORG_ID = "00000000-0000-0000-0000-000000000bbb";

async function findAuthUserByEmail(
  admin: ReturnType<typeof adminClient>,
  email: string,
) {
  let page = 1;
  const perPage = 200;
  while (true) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const match = data.users.find((user) => user.email === email);
    if (match) return match;
    if (!data.nextPage || data.users.length === 0) return null;
    page = data.nextPage;
  }
}

async function ensureLeadsTeammate(
  admin: ReturnType<typeof adminClient>,
): Promise<{ id: string; email: string }> {
  let teammate = await findAuthUserByEmail(admin, LEADS_TEAMMATE_EMAIL);
  if (!teammate) {
    const { data, error } = await admin.auth.admin.createUser({
      email: LEADS_TEAMMATE_EMAIL,
      email_confirm: true,
    });
    if (error || !data.user) throw error ?? new Error("teammate create failed");
    teammate = data.user;
  }

  type MembershipWriter = {
    from(table: "memberships"): {
      upsert(
        values: { user_id: string; org_id: string; role: "member" },
        options: { onConflict: string },
      ): Promise<{ error: { message: string } | null }>;
    };
  };
  const { error: membershipError } = await (
    admin as unknown as MembershipWriter
  )
    .from("memberships")
    .upsert(
      { user_id: teammate.id, org_id: DEFAULT_ORG_ID, role: "member" },
      { onConflict: "user_id,org_id" },
    );
  if (membershipError) throw new Error(membershipError.message);
  return { id: teammate.id, email: LEADS_TEAMMATE_EMAIL };
}

test("Leads board v2 foundation is usable at desktop and narrow widths", async ({
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

  const currentUserId = await ensureTestUser(admin);
  const teammate = await ensureLeadsTeammate(admin);

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
      assigned_user_id: currentUserId,
    })
    .select("id, org_id, address")
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

  const { data: attentionLeads, error: attentionLeadsError } = await admin
    .from("properties")
    .insert([
      {
        address: "456 Stale Conversation Ave",
        city: "Kansas City",
        state: "MO",
        status: "contacted",
        assigned_user_id: currentUserId,
      },
      {
        address: "789 Unassigned Lead Rd",
        city: "Kansas City",
        state: "MO",
        status: "new_lead",
        assigned_user_id: null,
      },
      {
        address: "654 Teammate Queue Blvd",
        city: "Kansas City",
        state: "MO",
        status: "new_lead",
        assigned_user_id: teammate.id,
      },
    ])
    .select("id, address, org_id");
  if (attentionLeadsError || !attentionLeads) {
    throw attentionLeadsError ?? new Error("attention lead seed failed");
  }
  const staleLead = attentionLeads.find((lead) =>
    lead.address.startsWith("456 Stale"),
  );
  const unassignedLead = attentionLeads.find((lead) =>
    lead.address.startsWith("789 Unassigned"),
  );
  if (!staleLead || !unassignedLead) {
    throw new Error("attention lead seed missing");
  }
  const { error: staleMessageError } = await admin.from("messages").insert({
    org_id: staleLead.org_id,
    property_id: staleLead.id,
    contact_id: contact.id,
    channel: "sms",
    direction: "inbound",
    status: "received",
    body: "Following up on the old conversation",
    created_at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
  });
  if (staleMessageError) throw staleMessageError;

  const { data: sequence, error: sequenceError } = await admin
    .from("sequences")
    .insert({
      org_id: unassignedLead.org_id,
      name: "Completed sequence browser proof",
      created_by: currentUserId,
    })
    .select("id")
    .single();
  if (sequenceError || !sequence) {
    throw sequenceError ?? new Error("sequence seed failed");
  }
  const { error: enrollmentError } = await admin
    .from("sequence_enrollments")
    .insert({
      org_id: unassignedLead.org_id,
      property_id: unassignedLead.id,
      sequence_id: sequence.id,
      status: "completed",
      completed_at: new Date(
        Date.now() - 2 * 24 * 60 * 60 * 1000,
      ).toISOString(),
    });
  if (enrollmentError) throw enrollmentError;

  await page.goto("/leads");
  await expect(page.getByRole("heading", { name: "Leads" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Import CSV/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add lead" })).toBeVisible();
  await expect(page.getByText("Taylor Seller · Kansas City, MO")).toBeVisible();
  await expect(page.getByTestId(`leadcard-last-message-${property.id}`)).toContainText(
    "Them: Can you call me tomorrow? · 3d",
  );

  const addressLink = page.getByRole("link", {
    name: `Open lead at ${property.address}`,
  });
  const boardUrl = page.url();
  const detailUrl = new URL(`/leads/${property.id}`, boardUrl).href;
  await expect(addressLink).toHaveAttribute("href", `/leads/${property.id}`);
  expect(await addressLink.evaluate((element) => element.tagName)).toBe("A");

  const newTabPromise = page.context().waitForEvent("page");
  await addressLink.click({ modifiers: ["ControlOrMeta"] });
  const detailTab = await newTabPromise;
  await expect(page).toHaveURL(boardUrl);
  await expect(detailTab).toHaveURL(detailUrl);
  await expect(
    detailTab.getByRole("heading", { name: property.address }),
  ).toBeVisible();
  await detailTab.close();

  const leadCard = page.getByRole("group", {
    name: `Lead at ${property.address}`,
  });
  await leadCard.getByRole("button", { name: "Set" }).click();
  await expect(page).toHaveURL(boardUrl);
  await expect(leadCard.getByLabel("Due date and time")).toBeVisible();
  await leadCard.getByRole("button", { name: "Cancel" }).click();

  await addressLink.click();
  await expect(page).toHaveURL(detailUrl);
  await expect(
    page.getByRole("heading", { name: property.address }),
  ).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(boardUrl);
  await expect(addressLink).toBeVisible();

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
  await expect(page.getByRole("button", { name: "All leads" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const ownershipControls = page.getByRole("group", { name: "Lead ownership" });
  await expect(ownershipControls.getByRole("button", { name: "My leads" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );

  await page.goto("/leads?assignee=me");
  await expect(ownershipControls.getByRole("button", { name: "My leads" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByText("123 Foundation Ave")).toBeVisible();
  await expect(page.getByText("789 Unassigned Lead Rd")).toHaveCount(0);
  await page
    .getByRole("combobox", { name: "Choose a teammate" })
    .selectOption(teammate.id);
  await expect(page).toHaveURL(
    new RegExp(`/leads\\?assignee=${teammate.id}$`),
  );
  await expect(page.getByText("654 Teammate Queue Blvd")).toBeVisible();
  await expect(page.getByText("123 Foundation Ave")).toHaveCount(0);

  await page.goto("/leads?assignee=me");
  await page.getByRole("button", { name: "Reset all (1)" }).click();
  await expect(page.getByText("789 Unassigned Lead Rd")).toBeVisible();
  await expect(page).toHaveURL(/\/leads$/);

  await page.goto("/leads?unassigned=true");
  await expect(page.getByRole("button", { name: "Unassigned", exact: true })).toBeVisible();
  await expect(page.getByText("789 Unassigned Lead Rd")).toBeVisible();
  await expect(page.getByText("123 Foundation Ave")).toHaveCount(0);
  await ownershipControls.getByRole("button", { name: "My leads" }).click();
  await expect(page).toHaveURL(/\/leads\?assignee=me$/);
  await expect(page.getByText("123 Foundation Ave")).toBeVisible();
  await expect(page.getByText("789 Unassigned Lead Rd")).toHaveCount(0);

  await page.goto("/leads?unassigned=true");
  await page.getByRole("button", { name: "Reset all (1)" }).click();
  await expect(page).toHaveURL(/\/leads$/);
  await expect(page.getByText("123 Foundation Ave")).toBeVisible();

  await page.goto("/leads?stale=true");
  await expect(
    page.getByRole("button", { name: /Stale conversations/ }),
  ).toBeVisible();
  await expect(page.getByText("456 Stale Conversation Ave")).toBeVisible();
  await expect(page.getByText("123 Foundation Ave")).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("leads-inbound-stale.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Reset all (1)" }).click();
  await expect(page).toHaveURL(/\/leads$/);
  await expect(page.getByText("123 Foundation Ave")).toBeVisible();

  await page.goto("/leads?sequence_ended=true");
  await expect(
    page.getByRole("button", { name: /Sequence ended without follow-up/ }),
  ).toBeVisible();
  await expect(page.getByText("789 Unassigned Lead Rd")).toBeVisible();
  await expect(page.getByText("123 Foundation Ave")).toHaveCount(0);
  await page.getByRole("button", { name: "Reset all (1)" }).click();
  await expect(page).toHaveURL(/\/leads$/);
  await expect(page.getByText("123 Foundation Ave")).toBeVisible();

  await page.goto("/leads?assignee=missing-user");
  await expect(page.getByRole("button", { name: "All leads" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByText("123 Foundation Ave")).toBeVisible();
  await expect(page.getByText(/Assigned to missing/i)).toHaveCount(0);
  await page.goto("/leads");

  await page.getByRole("button", { name: "Add lead" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByLabel("Street address")).toBeVisible();
  await expect(page.getByLabel("State")).toBeVisible();
  await expect(page.getByLabel("Market")).toBeVisible();
  await expect(page.getByLabel("Assigned teammate")).toBeVisible();
  await expect(page.getByLabel("Motivation (optional)")).toBeVisible();
  const desktopCreateBox = await page
    .getByRole("button", { name: "Create lead" })
    .boundingBox();
  expect(desktopCreateBox).not.toBeNull();
  expect(desktopCreateBox!.y + desktopCreateBox!.height).toBeLessThanOrEqual(720);
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
  await expect(page).toHaveURL(/\/leads$/);
  await expect(page.getByText("No leads match these filters")).toBeVisible();
  await expect(page.getByRole("button", { name: /Search: no-such-lead/ })).toBeVisible();
  await page.getByRole("button", { name: "Reset all", exact: true }).click();
  await expect(page.getByText("123 Foundation Ave")).toBeVisible();

  await page.setViewportSize({ width: 390, height: 600 });
  await page.getByRole("button", { name: "Add lead" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const narrowCreateBox = await page
    .getByRole("button", { name: "Create lead" })
    .boundingBox();
  expect(narrowCreateBox).not.toBeNull();
  expect(narrowCreateBox!.y + narrowCreateBox!.height).toBeLessThanOrEqual(600);
  await page.waitForTimeout(200);
  await page.screenshot({
    path: testInfo.outputPath("leads-add-dialog-narrow.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();

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
