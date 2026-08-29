import { expect, test } from "@playwright/test";

import {
  adminClient,
  E2E_MOCK_BUSINESS_NUMBER,
  ensureTestUser,
  resetTenantTables,
  seedProspects,
} from "./fixtures";
import { checkQuietHours, STATE_TO_TZ } from "../src/lib/messaging/quiet-hours";
import { ensureConversationIdForThread } from "../src/lib/messages/threading";

/**
 * Feature 8 Phase 1 — immediate reply flow from the cockpit side panel.
 * Inline replies use the protected send-now path. Mock messaging stamps an
 * external_id starting with `mock_` when provider delivery is accepted.
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
      phone_1_type: "mobile",
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
  const conversationId = await ensureConversationIdForThread(
    admin,
    contact.id,
    prop.id,
  );

  // Seed at least one prior message so the thread shows up in the inbox list.
  await admin.from("messages").insert({
    channel: "sms",
    direction: "inbound",
    status: "received",
    conversation_id: conversationId,
    contact_id: contact.id,
    property_id: prop.id,
    from_address: opts.phone,
    to_address: E2E_MOCK_BUSINESS_NUMBER,
    body: "asking the question",
  });

  return {
    contactId: contact.id,
    propertyId: prop.id,
    threadId: conversationId,
  };
}

function callableStateForNow(): string | null {
  for (const state of Object.keys(STATE_TO_TZ).sort()) {
    if (checkQuietHours(state).ok) return state;
  }
  return null;
}

test("type body, send reply → visible bubble + DB row is sent (tests 20 + 21)", async ({
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
  const { propertyId, threadId } = await seedConsentedThread(admin, {
    phone: "+18165557201",
    addressTag: "REPLY-OK",
    opted: "in",
    state: callableState,
  });

  await page.goto(`/messages?thread=${encodeURIComponent(threadId)}`);
  await expect(page.getByTestId("inbox-detail-panel")).toBeVisible();

  const reply = `cockpit reply ${Date.now()}`;
  const textarea = page.getByPlaceholder(/Type.*reply/i);
  await textarea.fill(reply);
  await page.getByTestId("inline-reply-send").click();

  // Mock provider acceptance produces a sent row and external provider ID.
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

  // The sent reply appears in the selected thread.
  await expect(page.getByTestId("inbox-detail-panel")).toContainText(reply);
});

test("Send button is disabled when the body is empty (test 22)", async ({
  page,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  await ensureTestUser(admin);

  const { threadId } = await seedConsentedThread(admin, {
    phone: "+18165557202",
    addressTag: "REPLY-EMPTY",
    opted: "in",
  });

  await page.goto(`/messages?thread=${encodeURIComponent(threadId)}`);
  const sendBtn = page.getByTestId("inline-reply-send");
  await expect(sendBtn).toBeDisabled();

  await page.getByPlaceholder(/Type.*reply/i).fill("now I have content");
  await expect(sendBtn).toBeEnabled();
});

test("opted-out contact renders a restriction instead of a composer (test 23)", async ({
  page,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  await ensureTestUser(admin);
  const { propertyId, threadId } = await seedConsentedThread(admin, {
    phone: "+18165557203",
    addressTag: "REPLY-NOCONSENT",
    opted: "out",
    state: "MO",
  });

  await page.goto(`/messages?thread=${encodeURIComponent(threadId)}`);
  const reply = `should be blocked ${Date.now()}`;
  await expect(
    page.getByText(/SMS disabled.*consent.*suppression/i).first(),
  ).toBeVisible();
  await expect(page.getByPlaceholder(/Type.*reply/i)).toHaveCount(0);
  await expect(page.getByTestId("inline-reply-send")).toHaveCount(0);

  const { data } = await admin
    .from("messages")
    .select("id")
    .eq("property_id", propertyId)
    .eq("body", reply);
  expect(data).toHaveLength(0);
});

test("unknown-state reply is blocked by the send-time quiet-hours check (test 24)", async ({
  page,
}) => {
  // Force quiet hours by setting the property to an unknown state so
  // checkQuietHours returns reason=unknown_state. Sidesteps the real
  // wall-clock dependency.
  const admin = adminClient();
  await resetTenantTables(admin);
  await ensureTestUser(admin);

  const { propertyId, threadId } = await seedConsentedThread(admin, {
    phone: "+18165557204",
    addressTag: "REPLY-QUIET",
    opted: "in",
  });
  await admin.from("properties").update({ state: "ZZ" }).eq("id", propertyId);

  await page.goto(`/messages?thread=${encodeURIComponent(threadId)}`);
  const reply = `send-time safety ${Date.now()}`;
  await page.getByPlaceholder(/Type.*reply/i).fill(reply);
  await page.getByTestId("inline-reply-send").click();

  await expect(page.getByText(/Blocked: quiet hours/i).first()).toBeVisible({
    timeout: 10_000,
  });

  const { data } = await admin
    .from("messages")
    .select("id")
    .eq("property_id", propertyId)
    .eq("body", reply);
  expect(data).toHaveLength(0);
});

test("after sending, the selected thread stays stable and shows the sent reply (test 25)", async ({
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
  // Two threads: sending on B must not navigate away.
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

  await page.goto(`/messages?thread=${encodeURIComponent(b.threadId)}`);
  const reply = `stay selected ${Date.now()}`;
  await page.getByPlaceholder(/Type.*reply/i).fill(reply);
  await page.getByTestId("inline-reply-send").click();

  await expect(page).toHaveURL(
    new RegExp(`[?&]thread=${encodeURIComponent(b.threadId)}`),
  );
  await expect(page.getByTestId("inbox-detail-panel")).toContainText(reply);
});
