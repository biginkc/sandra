import { expect, test } from "@playwright/test";

import {
  adminClient,
  ensureTestUser,
  resetTenantTables,
  seedProspects,
} from "./fixtures";

/**
 * Feature 8 Phase 1 — direct navigation to a specific tab + thread via
 * URL query string. Cockpit URLs need to be shareable so a teammate can
 * paste a link to "look at this conversation" and land in the right
 * place.
 */

test("/messages?tab=outbox loads with the Outbox tab active (test 32)", async ({
  page,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  await ensureTestUser(admin);

  await page.goto("/messages?tab=outbox");
  // Base UI tabs expose active state via aria-selected; data-active is
  // rendered without a value, so prefer the ARIA attribute.
  await expect(page.getByTestId("tab-outbox")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByTestId("tab-inbox")).toHaveAttribute(
    "aria-selected",
    "false",
  );
});

test("/messages?thread=<id> loads with that thread pre-selected in the side panel (test 33)", async ({
  page,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  await ensureTestUser(admin);

  // Seed two threads so we can verify the right one is selected, not just
  // "any panel rendered."
  const { data: contactA } = await admin
    .from("contacts")
    .insert({
      first_name: "Deep",
      last_name: "LinkA",
      phone_1: "+18165557501",
    })
    .select("id")
    .single();
  const [propA] = await seedProspects(admin, 1, "DEEP-A");
  await admin
    .from("properties")
    .update({ homeowner_contact_id: contactA!.id, status: "new_lead" })
    .eq("id", propA.id);
  await admin.from("messages").insert({
    channel: "sms",
    direction: "inbound",
    status: "received",
    contact_id: contactA!.id,
    property_id: propA.id,
    from_address: "+18165557501",
    to_address: "+18162804181",
    body: "thread A body",
  });

  const { data: contactB } = await admin
    .from("contacts")
    .insert({
      first_name: "Deep",
      last_name: "LinkB",
      phone_1: "+18165557502",
    })
    .select("id")
    .single();
  const [propB] = await seedProspects(admin, 1, "DEEP-B");
  await admin
    .from("properties")
    .update({ homeowner_contact_id: contactB!.id, status: "new_lead" })
    .eq("id", propB.id);
  await admin.from("messages").insert({
    channel: "sms",
    direction: "inbound",
    status: "received",
    contact_id: contactB!.id,
    property_id: propB.id,
    from_address: "+18165557502",
    to_address: "+18162804181",
    body: "thread B body",
  });

  await page.goto(`/messages?thread=${contactB!.id}`);
  await expect(page.getByTestId("inbox-detail-panel")).toContainText(
    "thread B body",
  );
  await expect(page.getByTestId("inbox-detail-panel")).not.toContainText(
    "thread A body",
  );
  await expect(
    page.getByTestId(`inbox-thread-${contactB!.id}`),
  ).toHaveAttribute("data-selected", "true");
});
