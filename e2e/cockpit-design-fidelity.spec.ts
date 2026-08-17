import { expect, test } from "@playwright/test";

import {
  adminClient,
  ensureTestUser,
  resetTenantTables,
  seedProspects,
} from "./fixtures";

/**
 * Visual fidelity check — captures /messages and /leads/[id] at 1440px
 * with a realistic seeded thread so the diff against the Stitch
 * reference render (`.stitch/designs/messages-cockpit/render-1440.png`
 * in the design-system repo) is meaningful.
 *
 * Not a pixel-perfect snapshot test — Stitch uses Tailwind CDN and a
 * different design-token resolution path than the real app, so a literal
 * pixel diff would never pass. The screenshots produced here are for
 * human review and live in `test-results/messages-cockpit/`.
 *
 * Also asserts the structural design contract that the warm-paper
 * implementation must hold: avatar size, dispo button labels, header
 * "Assigned:" line, FAB presence.
 */

async function seedDesignThread(admin: ReturnType<typeof adminClient>): Promise<{
  contactId: string;
  propertyId: string;
  threadId: string;
}> {
  const { data: contact } = await admin
    .from("contacts")
    .insert({
      first_name: "Maria",
      last_name: "Flores",
      phone_1: "+12105550192",
      phone_1_type: "mobile",
    })
    .select("id")
    .single();
  if (!contact) throw new Error("contact seed failed");

  const [prop] = await seedProspects(admin, 1, "DESIGN-FIDELITY");
  const { data: updated, error: updateError } = await admin
    .from("properties")
    .update({
      address: "4421 Blanco Rd",
      city: "San Antonio",
      state: "TX",
      homeowner_contact_id: contact.id,
      // "contacted" satisfies properties_status_check AND maps to a
      // StatusChip variant — exercises the pipeline chip in the panel
      // header. (The design renders the chip in a different colour
      // per variant; we only verify it appears, not its exact hue.)
      status: "contacted",
    })
    .eq("id", prop.id)
    .select("id, homeowner_contact_id, address");
  if (updateError) {
    throw new Error(`property update failed: ${updateError.message}`);
  }
  if (!updated || updated.length === 0) {
    throw new Error(`property update matched 0 rows for id=${prop.id}`);
  }
  if (updated[0].homeowner_contact_id !== contact.id) {
    throw new Error(
      `property update didn't persist homeowner_contact_id (got=${updated[0].homeowner_contact_id})`,
    );
  }

  const baseTime = Date.now();
  const messages: Array<{
    direction: "inbound" | "outbound";
    body: string;
    offsetMin: number;
  }> = [
    {
      direction: "inbound",
      body: "Hello, I saw the listing for 4421 Blanco Rd. Is it still available?",
      offsetMin: -180,
    },
    {
      direction: "outbound",
      body: "Hi Maria! Yes, it is. We actually have an open house this weekend. Would you like the details?",
      offsetMin: -178,
    },
    {
      direction: "inbound",
      body: "I might be able to make it. I'm interested in the price though, is it firm or is there room for negotiation?",
      offsetMin: -120,
    },
    {
      direction: "outbound",
      body: "The seller is motivated, but we've had a lot of interest. I'd recommend coming to see the condition first.",
      offsetMin: -117,
    },
  ];
  let threadId: string | null = null;
  for (const m of messages) {
    const { data: inserted, error: insertError } = await admin
      .from("messages")
      .insert({
        channel: "sms",
        direction: m.direction,
        status: m.direction === "inbound" ? "received" : "sent",
        contact_id: contact.id,
        property_id: prop.id,
        from_address:
          m.direction === "inbound" ? "+12105550192" : "+18162804181",
        to_address:
          m.direction === "inbound" ? "+18162804181" : "+12105550192",
        body: m.body,
        created_at: new Date(baseTime + m.offsetMin * 60_000).toISOString(),
        read_at: m.direction === "inbound" ? new Date().toISOString() : null,
      })
      .select("conversation_id")
      .single();
    if (insertError || !inserted?.conversation_id) {
      throw new Error(
        `message seed failed: ${insertError?.message ?? "missing conversation_id"}`,
      );
    }
    if (threadId && threadId !== inserted.conversation_id) {
      throw new Error("design messages were assigned to different conversations");
    }
    threadId = inserted.conversation_id;
  }

  if (!threadId) throw new Error("design thread seed returned no conversation");
  return { contactId: contact.id, propertyId: prop.id, threadId };
}

test.describe("Messages cockpit — design fidelity", () => {
  test("structural design contract holds at 1440px", async ({ page }) => {
    const admin = adminClient();
    await resetTenantTables(admin);
    await ensureTestUser(admin);
    const { threadId } = await seedDesignThread(admin);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/messages?thread=${threadId}`);
    await page.waitForSelector('[data-testid="inbox-detail-panel"]');

    // Page-level chrome
    await expect(page.getByTestId("messages-new-message")).toBeVisible();
    await expect(page.getByTestId("messages-fab")).toBeVisible();

    // Underline tabs
    await expect(page.getByTestId("tab-inbox")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByTestId("tab-outbox")).toHaveAttribute(
      "aria-selected",
      "false",
    );

    // Filter pills (rounded-full, "All" active by default)
    const allChip = page.getByTestId("filter-all");
    await expect(allChip).toHaveAttribute("data-active", "true");

    // Detail header — avatar circle (48px), status chip, Assigned line
    const panel = page.getByTestId("inbox-detail-panel");
    const headerAvatar = panel.locator("header > div .rounded-full").first();
    await expect(headerAvatar).toBeVisible();
    await expect(headerAvatar).toHaveClass(/w-12/);
    await expect(headerAvatar).toHaveClass(/h-12/);

    await expect(panel).toContainText("Maria Flores");
    await expect(panel).toContainText("4421 Blanco Rd");
    await expect(panel).toContainText(/Assigned:/);

    // Phone action lives in the More menu; the record link stays in the header.
    await expect(page.getByTestId("inbox-detail-phone")).toHaveCount(0);
    await page.getByTestId("inbox-detail-more").click();
    const actionsMenu = page.getByRole("menu");
    await expect(actionsMenu.getByTestId("inbox-detail-phone")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(actionsMenu).toBeHidden();
    await expect(page.getByTestId("inbox-detail-phone")).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`[?&]thread=${threadId}`));
    await expect(panel).toBeVisible();
    const openLead = page.getByTestId("inbox-detail-open-lead");
    await expect(openLead).toBeVisible();
    await expect(openLead).toContainText("Open lead");
    await expect(openLead).toBeEnabled();
    await expect(openLead).toHaveClass(/rounded-full/);

    // Dispo bar — same outcome controls for lead and prospect threads.
    await expect(page.getByTestId("dispo-wrong-number")).toContainText(
      "Wrong number",
    );
    await expect(page.getByTestId("dispo-not-interested")).toContainText(
      "Not interested",
    );
    const deferredDnc = page.getByTestId("dispo-dnc-deferred");
    await expect(deferredDnc).toContainText("Permanent DNC unavailable here");
    await expect(deferredDnc).toBeDisabled();
    const moveToLead = page.getByTestId("message-move-to-lead");
    await expect(moveToLead).toContainText("Move to Lead");
    await expect(moveToLead).toBeDisabled();
    await expect(page.getByTestId("dispo-more")).toBeVisible();
    await expect(page.getByTestId("message-open-lead")).toHaveCount(0);

    // Composer card with From: + queue-only button + Outbox disclaimer
    const reply = page.getByTestId("inline-reply");
    await expect(reply).toContainText("From:");
    await expect(reply.getByTestId("inline-reply-send")).toContainText(
      "Queue SMS",
    );
    await expect(reply).toContainText(/adds the message to Outbox/i);

    // Day separator pill in the thread
    await expect(page.getByTestId("messages-thread-day-sep").first()).toBeVisible();

    // Capture screenshot for visual review
    await page.screenshot({
      path: "test-results/messages-cockpit/messages-1440.png",
      fullPage: false,
    });
  });

  test("lead detail (/leads/[id]) inherits the new bubble + composer", async ({
    page,
  }) => {
    const admin = adminClient();
    await resetTenantTables(admin);
    await ensureTestUser(admin);
    const { propertyId } = await seedDesignThread(admin);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/leads/${propertyId}`);
    // Snap before asserting so a failure leaves a screenshot to inspect.
    await page.waitForLoadState("networkidle", { timeout: 10_000 });
    await page.screenshot({
      path: "test-results/messages-cockpit/leads-detail-1440.png",
      fullPage: true,
    });

    // Same MessagesThread → day separator + bubbles render
    await expect(page.getByTestId("messages-thread")).toBeVisible();
    await expect(page.getByTestId("messages-thread-day-sep").first()).toBeVisible();

    // Same InlineReply → From: line + queue-only button + disclaimer
    const reply = page.getByTestId("inline-reply");
    await expect(reply).toBeVisible();
    await expect(reply).toContainText("From:");
    await expect(reply.getByTestId("inline-reply-send")).toContainText(
      "Queue SMS",
    );
    await expect(reply).toContainText(/adds the message to Outbox/i);
  });
});
