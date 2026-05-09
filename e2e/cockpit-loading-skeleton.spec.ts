import { expect, test } from "@playwright/test";

import {
  adminClient,
  ensureTestUser,
  resetTenantTables,
  seedProspects,
} from "./fixtures";

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
  const contactIds: string[] = [];
  for (let i = 0; i < 2; i++) {
    const { data: contact, error: contactErr } = await admin
      .from("contacts")
      .insert({
        first_name: names[i].first,
        last_name: names[i].last,
        phone_1: phones[i],
      })
      .select("id")
      .single();
    if (contactErr || !contact) {
      throw new Error(
        `contact seed failed: ${contactErr?.message ?? "no row"}`,
      );
    }
    contactIds.push(contact.id);
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
    const { error: msgErr } = await admin.from("messages").insert({
      channel: "sms",
      direction: "inbound",
      status: "received",
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
  return contactIds;
}

test("clicking a thread surfaces the loading skeleton during navigation", async ({
  page,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  await ensureTestUser(admin);
  const [contactA, contactB] = await seedTwoThreads(admin);

  // Open with thread A pre-selected so the panel has real data first.
  await page.goto(`/messages?thread=${contactA}`);
  await page.waitForSelector('[data-testid="inbox-detail-panel"]');
  await page.waitForLoadState("networkidle");

  // Throttle the FIRST /messages document round-trip so the skeleton is
  // observable — the live env is fast enough that we'd race otherwise.
  // After we've seen the skeleton, drop the throttle so the rest of the
  // test isn't gated on additional 1s waits (Vercel/Next can issue
  // pre-fetches that would otherwise stack).
  let throttledOnce = false;
  await page.route("**/messages*", async (route) => {
    if (
      route.request().resourceType() === "document" &&
      !throttledOnce
    ) {
      throttledOnce = true;
      await new Promise((r) => setTimeout(r, 1500));
    }
    await route.continue();
  });

  // Click thread B — the real test.
  const clickPromise = page.getByTestId(`inbox-thread-${contactB}`).click();

  // Skeleton should appear within the throttle window. We poll quickly
  // because the React commit happens early in the transition.
  await expect(page.getByTestId("inbox-detail-loading")).toBeVisible({
    timeout: 2000,
  });

  // After the round-trip lands, skeleton disappears and the real panel
  // mounts with thread B's content. The handler throttles only once, so keep
  // it installed until navigation settles instead of tearing down a route
  // while its delayed document request may still be in flight.
  await clickPromise;
  const detailPanel = page.getByTestId("inbox-detail-panel");
  await expect(detailPanel).toBeVisible({ timeout: 20_000 });
  await expect(detailPanel).toContainText("body for Bob", { timeout: 20_000 });
  await expect(page.getByTestId("inbox-detail-loading")).toHaveCount(0, {
    timeout: 20_000,
  });
});
