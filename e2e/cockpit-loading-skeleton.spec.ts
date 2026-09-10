import { expect, test } from "@playwright/test";

import {
  adminClient,
  ensureTestUser,
  resetTenantTables,
  seedProspects,
} from "./fixtures";
import { ensureConversationIdForThread } from "../src/lib/messages/threading";

/**
 * Validates that clicking a different thread surfaces the loading
 * skeleton during the server round-trip. Throttles the route handler
 * via Playwright's `route()` interceptor to make the skeleton
 * observable (otherwise the round-trip on a hot test DB is sub-100ms
 * and the test can't catch it).
 */

async function seedTwoThreads(admin: ReturnType<typeof adminClient>) {
  const phones = ["+18165557401", "+18165557402"];
  const names = [
    { first: "Alice", last: "Adams" },
    { first: "Bob", last: "Brown" },
  ];
  const props = await seedProspects(admin, 2, "SKEL");
  if (props.length !== 2) {
    throw new Error(`seedProspects returned ${props.length}, expected 2`);
  }
  const seeded: Array<{ contactId: string; propertyId: string; threadId: string }> = [];
  for (let i = 0; i < 2; i++) {
    const { data: contact, error: contactErr } = await admin
      .from("contacts")
      .insert({
        first_name: names[i].first,
        last_name: names[i].last,
        phone_1: phones[i],
        phone_1_type: "mobile",
      })
      .select("id")
      .single();
    if (contactErr || !contact) {
      throw new Error(
        `contact seed failed: ${contactErr?.message ?? "no row"}`,
      );
    }
    const { error: propErr } = await admin
      .from("properties")
      .update({
        homeowner_contact_id: contact.id,
        status: "contacted",
      })
      .eq("id", props[i].id);
    if (propErr) {
      throw new Error(`property update failed: ${propErr.message}`);
    }
    const conversationId = await ensureConversationIdForThread(
      admin,
      contact.id,
      props[i].id,
    );
    seeded.push({
      contactId: contact.id,
      propertyId: props[i].id,
      threadId: conversationId,
    });
    const { error: msgErr } = await admin.from("messages").insert({
      channel: "sms",
      direction: "inbound",
      status: "received",
      conversation_id: conversationId,
      contact_id: contact.id,
      property_id: props[i].id,
      from_address: phones[i],
      to_address: "+18162804181",
      body: `body for ${names[i].first}`,
      created_at: new Date(Date.now() - (i + 1) * 60_000).toISOString(),
      read_at: new Date().toISOString(),
    });
    if (msgErr) throw new Error(`message insert failed: ${msgErr.message}`);
  }
  return seeded;
}

test("clicking a thread surfaces the loading skeleton during navigation", async ({
  page,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  await ensureTestUser(admin);
  const [threadA, threadB] = await seedTwoThreads(admin);

  // Open with thread A pre-selected so the panel has real data first.
  await page.goto(`/messages?thread=${encodeURIComponent(threadA.threadId)}`);
  await page.waitForSelector('[data-testid="inbox-detail-panel"]');
  await page.waitForLoadState("networkidle");

  // Delay only the selected conversation. The inbox page must not be the
  // transport for a click; this also makes its loading state deterministic.
  await page.route("**/api/messages/thread-detail?*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  const detailResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/messages/thread-detail" &&
      url.searchParams.get("thread") === threadB.threadId && response.ok();
  });

  // Click thread B — the real test.
  const clickPromise = page.getByTestId(`inbox-thread-${threadB.threadId}`).click();

  // Skeleton should appear within the throttle window. We poll quickly
  // because the React commit happens early in the transition.
  await expect(page.getByTestId("inbox-detail-loading")).toBeVisible({
    timeout: 2000,
  });

  // Detail comes from the bounded endpoint, with the list left in place.
  await clickPromise;
  await detailResponse;
  const detailPanel = page.getByTestId("inbox-detail-panel");
  await expect(detailPanel).toBeVisible({ timeout: 20_000 });
  await expect(detailPanel).toContainText("body for Bob", { timeout: 20_000 });
  await expect(page.getByTestId("inbox-detail-loading")).toHaveCount(0, {
    timeout: 20_000,
  });

  // Native selection updates retain A's cached server snapshot. Leave the
  // route through a real client navigation, then restore its URL from history.
  await page.getByRole("link", { name: "Leads", exact: true }).click();
  await expect(page).toHaveURL(/\/leads(?:\?|$)/);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`thread=${threadB.threadId}`));
  await expect(detailPanel).toContainText("body for Bob", { timeout: 20_000 });
  await expect(detailPanel).not.toContainText("body for Alice");
  await expect(page.getByTestId("inbox-detail-empty")).toHaveCount(0);
});
