import { expect, test } from "@playwright/test";

import {
  adminClient,
  ensureTestUser,
  resetTenantTables,
  seedProspects,
} from "./fixtures";

/**
 * Feature 7 — in-app notifications. Exercises the full Realtime path:
 * an inbound SMS webhook fires a notification row, Supabase Realtime
 * pushes the INSERT to the browser, the bell badge lights up without
 * a page reload. Then clicks the notification to land on the lead
 * detail + verify mark-read works end-to-end.
 *
 * The suite runs against `sandra-crm-test`. The signed-in user is
 * `claude@test.com` (the shared E2E test user) via the stored
 * storageState.
 */

async function seedAssignedInboundThread(
  admin: ReturnType<typeof adminClient>,
  opts: { phone: string; assigneeId: string; addressTag: string },
): Promise<{ propertyId: string; contactId: string }> {
  const { data: contact } = await admin
    .from("contacts")
    .insert({
      first_name: "Notif",
      last_name: "Smoke",
      phone_1: opts.phone,
    })
    .select("id")
    .single();
  if (!contact) throw new Error("contact seed failed");

  const [prop] = await seedProspects(admin, 1, opts.addressTag);
  // Promote out of prospect so the auto-qualify doesn't race with our
  // Realtime assertion. We're testing notifications, not qualify.
  await admin
    .from("properties")
    .update({
      homeowner_contact_id: contact.id,
      assigned_user_id: opts.assigneeId,
      status: "new_lead",
    })
    .eq("id", prop.id);

  // Prior outbound so the webhook can thread the inbound to a property.
  await admin.from("messages").insert({
    channel: "sms",
    direction: "outbound",
    status: "sent",
    from_address: "+18163706846",
    to_address: opts.phone,
    body: "Any updates on your property?",
    contact_id: contact.id,
    property_id: prop.id,
  });

  return { propertyId: prop.id, contactId: contact.id };
}

test("bell badge appears via Realtime when an inbound SMS notification fires (test 29)", async ({
  page,
  request,
  baseURL,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  const claudeId = await ensureTestUser(admin);

  const phone = "+18165552930";
  const { propertyId } = await seedAssignedInboundThread(admin, {
    phone,
    assigneeId: claudeId,
    addressTag: "NOTIF29",
  });

  // Land on the dashboard. No unread notifications yet.
  await page.goto("/leads");
  await expect(page.getByTestId("notifications-bell")).toBeVisible();
  await expect(page.getByTestId("notifications-badge")).toBeHidden();
  // Let the Realtime subscription handshake settle before firing the
  // INSERT — otherwise the browser can miss the broadcast if the
  // INSERT lands before `.subscribe()`'s ack arrives.
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(500);

  // Fire an inbound. The webhook will insert the message AND dispatch
  // owner_message_added to claudeId.
  const res = await request.post(`${baseURL}/api/webhooks/dialpad/sms`, {
    headers: {
      "x-mock-signature": "valid",
      "content-type": "application/json",
    },
    data: {
      externalId: `e2e_notif29_${Date.now()}`,
      from: phone,
      to: "+18163706846",
      body: "ready to talk numbers",
    },
  });
  expect(res.status()).toBe(200);

  // Verify the notification row exists first — fail-fast if dispatch
  // didn't fire, so we don't spend 10s waiting for a UI that can never
  // light up.
  await expect(async () => {
    const { data: notifs } = await admin
      .from("notifications")
      .select("user_id, entity_id, event_type")
      .eq("user_id", claudeId);
    expect(notifs).toHaveLength(1);
    expect(notifs![0]).toMatchObject({
      event_type: "owner_message_added",
      entity_id: propertyId,
    });
  }).toPass({ timeout: 5_000 });

  // Badge should appear via Realtime — generous timeout to absorb CI
  // jitter. The 15s safety-net poll also catches it if Realtime drops.
  await expect(page.getByTestId("notifications-badge")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("notifications-badge")).toHaveText("1");
});

test("click bell → open dropdown → click notification → routes + marks read (test 30)", async ({
  page,
  request,
  baseURL,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  const claudeId = await ensureTestUser(admin);

  const phone = "+18165552931";
  const { propertyId } = await seedAssignedInboundThread(admin, {
    phone,
    assigneeId: claudeId,
    addressTag: "NOTIF30",
  });

  await page.goto("/leads");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(500);

  // Fire the inbound.
  await request.post(`${baseURL}/api/webhooks/dialpad/sms`, {
    headers: {
      "x-mock-signature": "valid",
      "content-type": "application/json",
    },
    data: {
      externalId: `e2e_notif30_${Date.now()}`,
      from: phone,
      to: "+18163706846",
      body: "call me back when you can",
    },
  });

  await expect(page.getByTestId("notifications-badge")).toBeVisible({
    timeout: 20_000,
  });

  // Open the bell dropdown.
  await page.getByTestId("notifications-bell").click();

  // The dropdown row for this notification is visible.
  const item = page.locator(
    "[data-testid^='notifications-item-']:has-text('New SMS reply')",
  );
  await expect(item).toBeVisible();

  // Click → routes to /leads/<id> and clears the badge.
  await item.click();
  await page.waitForURL(new RegExp(`/leads/${propertyId}$`), {
    timeout: 5_000,
  });
  await expect(page.getByTestId("notifications-badge")).toBeHidden();

  // DB side-effect: read_at stamped.
  const { data: notifs } = await admin
    .from("notifications")
    .select("read_at")
    .eq("user_id", claudeId);
  expect(notifs![0].read_at).not.toBeNull();
});

test("seed 3 unread → 'Mark all as read' clears the badge (test 31)", async ({
  page,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  const claudeId = await ensureTestUser(admin);

  // Resolve an org id to satisfy the NOT NULL constraint on notifications.
  const { data: org } = await admin
    .from("organizations")
    .select("id")
    .limit(1)
    .single();
  if (!org) throw new Error("no organization in test project");

  // Seed 3 unread notifications for claude directly — no webhook needed.
  const entityIds = [
    "00000000-0000-0000-0000-0000000031a1",
    "00000000-0000-0000-0000-0000000031a2",
    "00000000-0000-0000-0000-0000000031a3",
  ];
  await admin.from("notifications").insert(
    entityIds.map((eid, i) => ({
      org_id: org.id,
      user_id: claudeId,
      event_type: "owner_message_added",
      entity_type: "property",
      entity_id: eid,
      title: `Seeded ${i + 1}`,
      body: `body ${i + 1}`,
    })),
  );

  await page.goto("/leads");
  await page.waitForLoadState("networkidle");

  // Badge shows 3 once the initial fetch lands.
  await expect(page.getByTestId("notifications-badge")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("notifications-badge")).toHaveText("3");

  // Open dropdown, click "Mark all as read".
  await page.getByTestId("notifications-bell").click();
  await expect(page.getByTestId("notifications-mark-all-read")).toBeVisible();
  await page.getByTestId("notifications-mark-all-read").click();

  // Badge clears (optimistic update).
  await expect(page.getByTestId("notifications-badge")).toBeHidden({
    timeout: 5_000,
  });

  // DB side-effect: every row has read_at set. Poll — the server action
  // is awaited inside the button's onClick, but Playwright's `.click()`
  // returns when the click event fires, not when the async handler
  // resolves. Polling is the simple, reliable pattern here.
  await expect(async () => {
    const { data: notifs } = await admin
      .from("notifications")
      .select("read_at")
      .eq("user_id", claudeId);
    expect(notifs).toHaveLength(3);
    for (const n of notifs ?? []) {
      expect(n.read_at).not.toBeNull();
    }
  }).toPass({ timeout: 5_000 });
});
