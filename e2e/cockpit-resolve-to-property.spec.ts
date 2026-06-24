import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import {
  adminClient,
  ensureTestUser,
  resetTenantTables,
  seedProspects,
} from "./fixtures";

test("known-contact propertyless thread can be resolved to a suggested property", async ({
  page,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  await ensureTestUser(admin);

  const phone = "+18165559091";
  const { data: contact } = await admin
    .from("contacts")
    .insert({
      first_name: "Resolve",
      last_name: "Cockpit",
      phone_1: phone,
      phone_1_type: "mobile",
    })
    .select("id")
    .single();
  if (!contact) throw new Error("contact seed failed");

  const [property] = await seedProspects(admin, 1, "RESOLVE-COCKPIT");
  await admin
    .from("properties")
    .update({
      homeowner_contact_id: contact.id,
      status: "prospect",
    })
    .eq("id", property.id);

  const sourceConversationId = randomUUID();
  await admin.from("messages").insert({
    channel: "sms",
    direction: "inbound",
    status: "received",
    contact_id: contact.id,
    property_id: null,
    conversation_id: sourceConversationId,
    from_address: phone,
    to_address: "+18162804181",
    body: "Which house is this about?",
  });

  await page.goto(`/messages?thread=${encodeURIComponent(sourceConversationId)}`);
  await expect(page.getByTestId("inbox-detail-panel")).toBeVisible();
  await expect(page.getByTestId("resolve-to-property-open")).toBeVisible();
  await expect(page.getByTestId("inline-reply")).toHaveCount(0);

  await page.getByTestId("resolve-to-property-open").click();
  await expect(page.getByTestId("resolve-candidates")).toBeVisible();
  await expect(
    page.getByTestId(`resolve-property-result-${property.id}`),
  ).toBeVisible({ timeout: 10_000 });
  await page.getByTestId(`resolve-property-result-${property.id}`).click();
  await page.getByTestId("resolve-property-submit").click();

  await expect(page.getByTestId("inline-reply")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId("dispo-wrong-number")).toBeVisible();
  await expect(page.getByTestId("resolve-to-property-open")).toHaveCount(0);

  await expect(async () => {
    const { data } = await admin
      .from("messages")
      .select("property_id, conversation_id")
      .eq("contact_id", contact.id)
      .eq("body", "Which house is this about?")
      .single();
    expect(data!.property_id).toBe(property.id);
    expect(data!.conversation_id).not.toBe(sourceConversationId);
  }).toPass({ timeout: 10_000 });
});
