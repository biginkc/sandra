import { expect, test } from "@playwright/test";

import { checkQuietHours, STATE_TO_TZ } from "../src/lib/messaging/quiet-hours";
import { adminClient, ensureTestUser, resetTenantTables } from "./fixtures";

const DEFAULT_ORG_ID = "00000000-0000-0000-0000-000000000bbb";

function callableStateForNow(): string {
  for (const state of Object.keys(STATE_TO_TZ).sort()) {
    if (checkQuietHours(state).ok) return state;
  }
  return "MO";
}

function uniquePhone(): string {
  return `+1816${String(Date.now()).slice(-7)}`;
}

async function seedCallableProspect() {
  const admin = adminClient();
  const state = callableStateForNow();
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const address = `Dialer E2E ${suffix} Golden Path Ln`;

  const { data: contact, error: contactError } = await admin
    .from("contacts")
    .insert({
      org_id: DEFAULT_ORG_ID,
      first_name: "Dialer",
      last_name: "E2E",
      phone_1: uniquePhone(),
      do_not_contact: false,
    })
    .select("id")
    .single();
  if (contactError || !contact) {
    throw contactError ?? new Error("seedCallableProspect contact insert failed");
  }

  const { data: property, error: propertyError } = await admin
    .from("properties")
    .insert({
      org_id: DEFAULT_ORG_ID,
      address,
      state,
      status: "prospect",
      cass_status: "verified",
      market: "Kansas City",
      city: "Kansas City",
      zip: "64151",
      homeowner_contact_id: contact.id,
    })
    .select("id, address")
    .single();
  if (propertyError || !property) {
    throw propertyError ?? new Error("seedCallableProspect property insert failed");
  }

  return { contactId: contact.id, propertyId: property.id, address: property.address };
}

test.describe("Dialer batch create", () => {
  test("batch create end-to-end: selected prospect creates batch and lead widget shows call count", async ({
    page,
  }) => {
    const admin = adminClient();
    await resetTenantTables(admin);
    await ensureTestUser(admin);
    const prospect = await seedCallableProspect();
    const title = `E2E dialer batch ${Date.now()}`;

    await page.goto("/properties");
    await expect(page.getByText(prospect.address)).toBeVisible({
      timeout: 15_000,
    });

    await page
      .getByRole("checkbox", { name: "Select all prospects on this page" })
      .check();
    await page
      .getByRole("button", { name: /actions for 1 selected/i })
      .click();
    await page.getByRole("menuitem", { name: "Create dialer batch" }).click();

    await expect(
      page.getByRole("dialog", { name: "Create dialer batch" }),
    ).toBeVisible();
    await expect(page.getByText("1 callable")).toBeVisible({ timeout: 15_000 });
    await page.getByLabel("Batch title").fill(title);
    await page.getByRole("button", { name: "Create batch" }).click();

    await expect(async () => {
      const { data: batch } = await (admin as any)
        .from("dialer_batches")
        .select("id, source_kind")
        .eq("title", title)
        .single();
      expect(batch?.source_kind).toBe("selected_ids");

      const { data: items } = await (admin as any)
        .from("dialer_batch_items")
        .select("id, property_id, contact_id")
        .eq("batch_id", batch.id);
      expect(items).toHaveLength(1);
      expect(items?.[0]?.property_id).toBe(prospect.propertyId);
      expect(items?.[0]?.contact_id).toBe(prospect.contactId);
    }).toPass({ timeout: 15_000 });

    const { data: item, error: itemError } = await (admin as any)
      .from("dialer_batch_items")
      .select("id")
      .eq("property_id", prospect.propertyId)
      .single();
    if (itemError || !item) {
      throw itemError ?? new Error("Expected created dialer batch item");
    }

    const { error: activityError } = await (admin as any)
      .from("call_activities")
      .insert({
        org_id: DEFAULT_ORG_ID,
        property_id: prospect.propertyId,
        contact_id: prospect.contactId,
        dialer_batch_item_id: item.id,
        jitter_attempt_id: `e2e-${Date.now()}`,
        started_at: new Date().toISOString(),
        outcome: "connected_human",
        recording_status: "available",
        transcript_status: "available",
      });
    if (activityError) throw activityError;

    await page.goto(`/leads/${prospect.propertyId}`);
    await expect(page.getByRole("region", { name: "Calls" })).toContainText(
      "1 call",
      { timeout: 15_000 },
    );
    await expect(page.getByTestId("latest-outcome-badge")).toHaveText(
      "Connected",
    );
    await expect(page.getByText("1 available").first()).toBeVisible();
  });
});
