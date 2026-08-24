import { expect, test } from "@playwright/test";

import {
  adminClient,
  DEFAULT_ORG_ID,
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

async function seedDesignThread(
  admin: ReturnType<typeof adminClient>,
): Promise<{
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
    .select("id, org_id, homeowner_contact_id, address");
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
  if (updated[0].org_id !== DEFAULT_ORG_ID) {
    throw new Error(
      `property update used unexpected org (got=${updated[0].org_id})`,
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
        to_address: m.direction === "inbound" ? "+18162804181" : "+12105550192",
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
      throw new Error(
        "design messages were assigned to different conversations",
      );
    }
    threadId = inserted.conversation_id;
  }

  const { error: noteError } = await admin.from("lead_notes").insert({
    org_id: DEFAULT_ORG_ID,
    property_id: prop.id,
    body: "Seller mentioned the roof was replaced last year.",
    created_at: new Date(baseTime - 179 * 60_000).toISOString(),
  });
  if (noteError) throw new Error(`note seed failed: ${noteError.message}`);

  const callTime = new Date(baseTime - 119 * 60_000).toISOString();
  const { error: callError } = await admin.from("call_activities").insert({
    org_id: DEFAULT_ORG_ID,
    property_id: prop.id,
    contact_id: contact.id,
    provider: "jitter",
    jitter_session_id: "design-fidelity",
    jitter_attempt_id: `design-fidelity-${Date.now()}`,
    created_at: callTime,
    started_at: callTime,
    outcome: "connected_human",
  });
  if (callError) throw new Error(`call seed failed: ${callError.message}`);

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
    await expect(page.getByTestId("dispo-dnc")).toHaveCount(0);
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
    await expect(
      page.getByTestId("messages-thread-day-sep").first(),
    ).toBeVisible();

    // Capture screenshot for visual review
    await page.screenshot({
      path: "test-results/messages-cockpit/messages-1440.png",
      fullPage: false,
    });
  });

  test("lead detail (/leads/[id]) matches the compact responsive contract", async ({
    page,
  }, testInfo) => {
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

    // Lead detail now normalizes messages, notes, and calls into one timeline.
    const timeline = page.getByTestId("lead-activity-timeline");
    await expect(timeline).toBeVisible();
    const events = timeline.locator(
      '[data-testid="messages-thread-msg"], [data-testid="lead-activity-note"], [data-testid="lead-activity-call"]',
    );
    await expect(events).toHaveCount(6);
    expect(
      await events.evaluateAll((rows) =>
        rows.map((row) => row.getAttribute("data-testid")),
      ),
    ).toEqual([
      "messages-thread-msg",
      "lead-activity-note",
      "messages-thread-msg",
      "messages-thread-msg",
      "lead-activity-call",
      "messages-thread-msg",
    ]);
    await expect(timeline.getByTestId("lead-activity-note")).toContainText(
      "roof was replaced",
    );
    await expect(timeline.getByTestId("lead-activity-call")).toContainText(
      "Connected",
    );

    // Same InlineReply → From: line + queue-only button + disclaimer
    const reply = page.getByTestId("inline-reply");
    await expect(reply).toBeVisible();
    await expect(reply).toContainText("From:");
    await expect(reply.getByTestId("inline-reply-send")).toContainText(
      "Queue SMS",
    );
    await expect(reply).toContainText(/adds the message to Outbox/i);
    await expect(reply.getByTestId("lead-add-note-composer")).toBeVisible();

    // These stable landmarks distinguish the approved compact redesign from
    // the oversized card layout it replaced.
    await expect(page.getByRole("link", { name: /^Back\b/i })).toHaveCount(0);
    await expect(page.getByTestId("lead-working-state-bar")).toBeVisible();
    await expect(page.getByTestId("lead-no-next-action")).toHaveAttribute(
      "data-variant",
      "compact",
    );
    await expect(timeline).toHaveAttribute(
      "data-presentation",
      "open-timeline",
    );
    await expect(
      timeline.locator('[data-presentation="timeline"]').first(),
    ).toBeVisible();
    await expect(
      page.locator(
        'aside[aria-label="Lead dossier"] [data-lead-section="compact"]',
      ),
    ).not.toHaveCount(0);

    // The approved chat order keeps reply controls after all timeline rows.
    expect(
      await page.evaluate(() => {
        const activity = document.querySelector(
          '[data-testid="lead-activity-timeline"]',
        );
        const composer = document.querySelector('[data-testid="inline-reply"]');
        return Boolean(
          activity &&
          composer &&
          activity.compareDocumentPosition(composer) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        );
      }),
    ).toBe(true);

    const viewports = [
      { width: 1280, height: 900, dossierBeside: true },
      { width: 1024, height: 900, dossierBeside: false },
      { width: 390, height: 844, dossierBeside: false },
      { width: 320, height: 800, dossierBeside: false },
    ] as const;

    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      // Responsive CSS updates in-place. Keep the already-verified lead DOM
      // mounted so another shared-tenant suite cannot delete the fixture
      // between viewport checks and turn a layout test into a database race.
      await page.waitForTimeout(100);
      const timeline = page.getByTestId("lead-activity-timeline");
      const dossier = page.locator('aside[aria-label="Lead dossier"]');
      await expect(timeline).toBeVisible();
      await expect(dossier).toBeVisible();

      const layout = await page.evaluate(() => {
        const timelineNode = document.querySelector(
          '[data-testid="lead-activity-timeline"]',
        );
        const dossierNode = document.querySelector(
          'aside[aria-label="Lead dossier"]',
        );
        if (!timelineNode || !dossierNode) return null;
        const timelineRect = timelineNode.getBoundingClientRect();
        const dossierRect = dossierNode.getBoundingClientRect();
        return {
          overflow: document.documentElement.scrollWidth - window.innerWidth,
          timelineTop: timelineRect.top,
          dossierTop: dossierRect.top,
          timelineRight: timelineRect.right,
          dossierLeft: dossierRect.left,
        };
      });
      expect(layout).not.toBeNull();
      expect(layout!.overflow).toBeLessThanOrEqual(1);
      if (viewport.dossierBeside) {
        expect(Math.abs(layout!.timelineTop - layout!.dossierTop)).toBeLessThan(
          8,
        );
        expect(layout!.dossierLeft).toBeGreaterThan(layout!.timelineRight);
      } else {
        expect(layout!.dossierTop).toBeGreaterThan(layout!.timelineTop);
      }

      if (viewport.width <= 390) {
        const undersized = await page
          .locator('main button:visible, [data-variant="compact"] a:visible')
          .evaluateAll((buttons) =>
            buttons
              .map((button) => ({
                label:
                  button.getAttribute("aria-label") ??
                  button.textContent?.trim() ??
                  "button",
                height: button.getBoundingClientRect().height,
              }))
              .filter(({ height }) => height > 0 && height < 35.5),
          );
        expect(undersized).toEqual([]);
      }

      const mediaHero = page.locator(
        '[data-testid="lead-media-street-view"], [data-testid="lead-media-aerial"]',
      );
      if ((await mediaHero.count()) > 0) {
        const mediaLayout = await page.evaluate(() => {
          const hero = document.querySelector(
            '[data-testid="lead-media-street-view"], [data-testid="lead-media-aerial"]',
          );
          const overlay = document.querySelector(
            '[data-testid="lead-media-overlay"]',
          );
          if (!hero || !overlay) return null;
          const heroRect = hero.getBoundingClientRect();
          const overlayRect = overlay.getBoundingClientRect();
          return {
            heroLeft: heroRect.left,
            heroRight: heroRect.right,
            heroTop: heroRect.top,
            heroBottom: heroRect.bottom,
            overlayLeft: overlayRect.left,
            overlayRight: overlayRect.right,
            overlayTop: overlayRect.top,
            overlayBottom: overlayRect.bottom,
          };
        });
        expect(mediaLayout).not.toBeNull();
        expect(mediaLayout!.overlayLeft).toBeGreaterThanOrEqual(
          mediaLayout!.heroLeft,
        );
        expect(mediaLayout!.overlayRight).toBeLessThanOrEqual(
          mediaLayout!.heroRight,
        );
        expect(mediaLayout!.overlayTop).toBeGreaterThanOrEqual(
          mediaLayout!.heroTop,
        );
        expect(mediaLayout!.overlayBottom).toBeLessThanOrEqual(
          mediaLayout!.heroBottom + 1,
        );
      }

      await page.screenshot({
        path: testInfo.outputPath(`lead-detail-${viewport.width}.png`),
        fullPage: false,
      });
    }
  });
});
