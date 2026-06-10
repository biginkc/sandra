import { expect, test } from "@playwright/test";

import {
  adminClient,
  ensureTestUser,
  resetTenantTables,
  seedProspects,
} from "./fixtures";
import { checkQuietHours, STATE_TO_TZ } from "../src/lib/messaging/quiet-hours";

/**
 * Feature 8 Phase 1 — send-now reply flow from the cockpit side panel.
 * The reply goes through the existing InlineReply → sendSmsFromLead →
 * sendSmsToContact path with queueOnly=false. Mock messaging provider
 * stamps an external_id starting with `mock_`.
 */

async function seedConsentedThread(
  admin: ReturnType<typeof adminClient>,
  opts: {
    phone: string;
    addressTag: string;
    opted?: "in" | "out" | "none";
    state?: string;
  },
): Promise<{ contactId: string; propertyId: string; threadId: string }> {
  const opted = opts.opted ?? "in";
  const { data: contact } = await admin
    .from("contacts")
    .insert({
      first_name: "Reply",
      last_name: "Test",
      phone_1: opts.phone,
    })
    .select("id")
    .single();
  if (!contact) throw new Error("contact seed failed");

  const [prop] = await seedProspects(admin, 1, opts.addressTag);
  await admin
    .from("properties")
    .update({
      homeowner_contact_id: contact.id,
      status: "new_lead",
      state: opts.state,
    })
    .eq("id", prop.id);

  if (opted === "in") {
    await admin.from("consent_events").insert({
      contact_id: contact.id,
      channel: "sms",
      event_type: "opt_in_marketing_written",
      source: "e2e-cockpit-reply",
    });
  } else if (opted === "out") {
    await admin.from("consent_events").insert({
      contact_id: contact.id,
      channel: "sms",
      event_type: "opt_out",
      source: "e2e-cockpit-reply",
    });
  }

  // Seed at least one prior message so the thread shows up in the inbox list.
  await admin.from("messages").insert({
    channel: "sms",
    direction: "inbound",
    status: "received",
    contact_id: contact.id,
    property_id: prop.id,
    from_address: opts.phone,
    to_address: "+18162804181",
    body: "asking the question",
  });

  return {
    contactId: contact.id,
    propertyId: prop.id,
    threadId: `legacy:${contact.id}:${prop.id}`,
  };
}

function callableStateForNow(): string | null {
  for (const state of Object.keys(STATE_TO_TZ).sort()) {
    if (checkQuietHours(state).ok) return state;
  }
  return null;
}

test("type body, hit Send → bubble appears + DB row is status='sent' (tests 20 + 21)", async ({
  page,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  await ensureTestUser(admin);
  const callableState = callableStateForNow();
  if (callableState === null) {
    test.skip(true, "outside legal send windows in every configured US state");
    return;
  }

  const { contactId, propertyId } = await seedConsentedThread(admin, {
    phone: "+18165557201",
    addressTag: "REPLY-OK",
    opted: "in",
    state: callableState,
  });

  await page.goto(`/messages?thread=${contactId}`);
  await expect(page.getByTestId("inbox-detail-panel")).toBeVisible();

  const reply = `cockpit reply ${Date.now()}`;
  const textarea = page.getByPlaceholder(/Type.*reply/i);
  await textarea.fill(reply);
  await page.getByRole("button", { name: /Send reply/i }).click();

  // DB shows the new outbound row at status='sent' with mock external_id.
  await expect(async () => {
    const { data } = await admin
      .from("messages")
      .select("status, direction, body, external_id")
      .eq("property_id", propertyId)
      .eq("body", reply);
    expect(data).toHaveLength(1);
    expect(data![0].status).toBe("sent");
    expect(data![0].direction).toBe("outbound");
    expect(data![0].external_id).toMatch(/^mock_/);
  }).toPass({ timeout: 10_000 });

  // Bubble appears in the panel.
  await expect(page.getByTestId("inbox-detail-panel")).toContainText(reply);
});

test("Send button is disabled when the body is empty (test 22)", async ({
  page,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  await ensureTestUser(admin);

  const { contactId } = await seedConsentedThread(admin, {
    phone: "+18165557202",
    addressTag: "REPLY-EMPTY",
    opted: "in",
  });

  await page.goto(`/messages?thread=${contactId}`);
  const sendBtn = page.getByRole("button", { name: /Send reply/i });
  await expect(sendBtn).toBeDisabled();

  await page.getByPlaceholder(/Type.*reply/i).fill("now I have content");
  await expect(sendBtn).toBeEnabled();
});

test("reply to opted-out contact surfaces consent block (test 23)", async ({
  page,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  await ensureTestUser(admin);
  const callableState = callableStateForNow();
  if (callableState === null) {
    test.skip(true, "outside legal send windows in every configured US state");
    return;
  }

  const { contactId, propertyId } = await seedConsentedThread(admin, {
    phone: "+18165557203",
    addressTag: "REPLY-NOCONSENT",
    opted: "out",
    state: callableState,
  });

  await page.goto(`/messages?thread=${contactId}`);
  const reply = `should be blocked ${Date.now()}`;
  await page.getByPlaceholder(/Type.*reply/i).fill(reply);
  await page.getByRole("button", { name: /Send reply/i }).click();

  // Toast surfaces.
  await expect(
    page.getByText(/Blocked.*consent|opted out/i).first(),
  ).toBeVisible({ timeout: 10_000 });

  // No outbound row was created with that body.
  const { data } = await admin
    .from("messages")
    .select("id")
    .eq("property_id", propertyId)
    .eq("body", reply);
  expect(data).toHaveLength(0);
});

test("reply during quiet hours surfaces quiet-hours block (test 24)", async ({
  page,
}) => {
  // Force quiet hours by setting the property to an unknown state so
  // checkQuietHours returns reason=unknown_state. Sidesteps the real
  // wall-clock dependency.
  const admin = adminClient();
  await resetTenantTables(admin);
  await ensureTestUser(admin);

  const { contactId, propertyId } = await seedConsentedThread(admin, {
    phone: "+18165557204",
    addressTag: "REPLY-QUIET",
    opted: "in",
  });
  await admin
    .from("properties")
    .update({ state: "ZZ" })
    .eq("id", propertyId);

  await page.goto(`/messages?thread=${contactId}`);
  const reply = `should be quiet-blocked ${Date.now()}`;
  await page.getByPlaceholder(/Type.*reply/i).fill(reply);
  await page.getByRole("button", { name: /Send reply/i }).click();

  await expect(
    page.getByText(/quiet hours|state/i).first(),
  ).toBeVisible({ timeout: 10_000 });

  const { data } = await admin
    .from("messages")
    .select("id")
    .eq("property_id", propertyId)
    .eq("body", reply);
  expect(data).toHaveLength(0);
});

test("after a successful send, the thread jumps to the top of the inbox (test 25)", async ({
  page,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  await ensureTestUser(admin);
  const callableState = callableStateForNow();
  if (callableState === null) {
    test.skip(true, "outside legal send windows in every configured US state");
    return;
  }

  // Two threads: A is older, B is the one we'll reply to. After the
  // reply, B should jump to the top.
  const a = await seedConsentedThread(admin, {
    phone: "+18165557205",
    addressTag: "REPLY-A",
    opted: "in",
    state: callableState,
  });
  await admin
    .from("messages")
    .update({ created_at: new Date(Date.now() - 60 * 60_000).toISOString() })
    .eq("contact_id", a.contactId);

  const b = await seedConsentedThread(admin, {
    phone: "+18165557206",
    addressTag: "REPLY-B",
    opted: "in",
    state: callableState,
  });
  await admin
    .from("messages")
    .update({ created_at: new Date(Date.now() - 30 * 60_000).toISOString() })
    .eq("contact_id", b.contactId);

  await page.goto(`/messages?thread=${b.contactId}`);
  await page.getByPlaceholder(/Type.*reply/i).fill(`bump ${Date.now()}`);
  await page.getByRole("button", { name: /Send reply/i }).click();

  // Wait for the send to round-trip and the list to refresh.
  await expect(async () => {
    const list = page.getByTestId("inbox-thread-list");
    const buttons = list.locator("button");
    const firstId = await buttons.first().getAttribute("data-testid");
    expect(firstId).toBe(`inbox-thread-${b.threadId}`);
  }).toPass({ timeout: 10_000 });
});
