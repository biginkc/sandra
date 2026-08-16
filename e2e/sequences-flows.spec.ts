import { expect, test, type Page } from "@playwright/test";

import { seedStarterLibrary } from "../src/lib/sequences/starter-library";

import {
  adminClient,
  DEFAULT_ORG_ID,
  ensureTestUser,
  resetTenantTables,
  seedProspects,
} from "./fixtures";

/**
 * Feature 5a — Sequences V1, deeper browser-driven coverage.
 *
 * Complements `e2e/sequences.spec.ts` (which only covered index-renders
 * + new-sequence). These tests exercise the UI flows that previously
 * had only typecheck coverage:
 *
 *   1. Create → edit → archive → restore
 *   5. Enroll from lead detail (change_status step, no real SMS)
 *   6. Cancel an enrollment from the lead-detail widget
 *   7. Impact modal confirm on save with active enrollments
 *   8. Sidebar nav links all route correctly
 *
 * Tests 2/3/4 (add-step modal validation, delay unit picker, delete
 * step) migrated to RTL — see
 * `src/app/(dashboard)/sequences/[id]/edit/editor.test.tsx`.
 *
 * Runs against the `sandra-crm-test` Supabase project + mock messaging
 * provider (same as the rest of our E2E suite). No real SMS is sent.
 */

// Helpers ---------------------------------------------------------------------

async function seedOrgId(): Promise<string> {
  return DEFAULT_ORG_ID;
}

async function seedSequenceWithOneStep(
  admin: ReturnType<typeof adminClient>,
  opts: {
    name: string;
    actionType?: "send_sms" | "change_status";
    body?: string;
    targetStatus?: string;
    delayMinutes?: number;
  },
): Promise<{ sequenceId: string; stepId: string }> {
  const orgId = await seedOrgId();
  const { data: seq } = await admin
    .from("sequences")
    .insert({ org_id: orgId, name: opts.name })
    .select("id")
    .single();
  const { data: step } = await admin
    .from("sequence_steps")
    .insert({
      sequence_id: seq!.id,
      step_index: 0,
      delay_after_previous_minutes: opts.delayMinutes ?? 0,
      action_type: opts.actionType ?? "send_sms",
      template_body: opts.actionType === "change_status" ? null : opts.body ?? "Hi",
      target_status:
        opts.actionType === "change_status" ? opts.targetStatus ?? "contacted" : null,
    })
    .select("id")
    .single();
  return { sequenceId: seq!.id, stepId: step!.id };
}

async function seedLeadWithConsent(
  admin: ReturnType<typeof adminClient>,
  opts: { phone: string; address?: string; status?: string },
): Promise<{ propertyId: string; contactId: string }> {
  const { data: contact } = await admin
    .from("contacts")
    .insert({
      org_id: DEFAULT_ORG_ID,
      first_name: "Browser",
      last_name: "Test",
      phone_1: opts.phone,
      phone_1_type: "mobile",
    })
    .select("id")
    .single();
  await admin.from("consent_events").insert({
    org_id: DEFAULT_ORG_ID,
    contact_id: contact!.id,
    channel: "sms",
    event_type: "opt_in_marketing_written",
    source: "e2e-seed",
  });
  const [prop] = await seedProspects(admin, 1, opts.address ?? "E2E Seq");
  await admin
    .from("properties")
    .update({
      homeowner_contact_id: contact!.id,
      status: opts.status ?? "new_lead",
    })
    .eq("id", prop.id);
  return { propertyId: prop.id, contactId: contact!.id };
}

/** Generous wait so redirect + refresh after a save doesn't flake. */
async function waitForSettled(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
}

// Tests -----------------------------------------------------------------------

test.describe("Sequences V1 — UI flows (browser)", () => {
  test.beforeEach(async () => {
    const admin = adminClient();
    await resetTenantTables(admin);
    await ensureTestUser(admin);
    // Note: dialog handlers (`page.on("dialog", …)` or
    // `page.once("dialog", …)`) are installed per-test — a catch-all in
    // beforeEach conflicts with tests that want to capture + assert on
    // the dialog message before accepting.
  });

  test("1. create → edit meta → archive → restore round-trip", async ({ page }) => {
    const admin = adminClient();

    // Create
    await page.goto("/sequences/new");
    const uniqueName = `Flow-1 ${Date.now()}`;
    await page.getByLabel("Name").fill(uniqueName);
    await page
      .getByLabel("Description")
      .fill("Created by the flow-1 smoke");
    await page.getByRole("button", { name: /^create$/i }).click();
    await page.waitForURL(/\/sequences\/[0-9a-f-]+\/edit$/, { timeout: 10_000 });
    await expect(page.getByRole("heading", { name: uniqueName })).toBeVisible();

    // Edit description via the meta form, confirm impact modal (no enrollments yet → no modal)
    const descInput = page.getByLabel("Description");
    await descInput.fill("Edited by the flow-1 smoke");
    await page.getByRole("button", { name: /^save$/i }).first().click();
    await waitForSettled(page);

    // Archive via the index page row action
    await page.goto("/sequences");
    const row = page.locator("tr", { hasText: uniqueName });
    await expect(row).toBeVisible();
    page.once("dialog", (d) => void d.accept());
    await row.getByRole("button", { name: /archive/i }).click();

    // Poll the DB — the server action + router.refresh() aren't instant.
    await expect(async () => {
      const { data } = await admin
        .from("sequences")
        .select("archived_at, active")
        .eq("name", uniqueName)
        .single();
      expect(data!.archived_at).not.toBeNull();
      expect(data!.active).toBe(false);
    }).toPass({ timeout: 5_000 });

    // UI caught up
    await page.reload();
    const archivedSection = page
      .locator("section")
      .filter({ hasText: "Archived" });
    await expect(archivedSection.getByText(uniqueName)).toBeVisible();

    // Restore
    await archivedSection
      .locator("tr", { hasText: uniqueName })
      .getByRole("button", { name: /restore/i })
      .click();

    await expect(async () => {
      const { data } = await admin
        .from("sequences")
        .select("active")
        .eq("name", uniqueName)
        .single();
      expect(data!.active).toBe(true);
    }).toPass({ timeout: 5_000 });
  });

  test("5. enroll from lead detail widget creates an active enrollment (change_status, no SMS)", async ({
    page,
  }) => {
    const admin = adminClient();
    const sequenceName = `Flow-5 ${Date.now()}`;
    const { sequenceId } = await seedSequenceWithOneStep(admin, {
      name: sequenceName,
      actionType: "change_status",
      targetStatus: "contacted",
      delayMinutes: 99999, // don't fire during the test
    });
    // Mark sequence active (default true) — explicit assertion
    await admin
      .from("sequences")
      .update({ active: true })
      .eq("id", sequenceId);

    const { propertyId } = await seedLeadWithConsent(admin, {
      phone: "+18165559401",
    });

    await page.goto(`/leads/${propertyId}`);
    const enrollBtn = page.getByTestId("enroll-in-sequence-button");
    await expect(enrollBtn).toBeVisible();
    await enrollBtn.click();

    // Dropdown row with the sequence name appears
    const option = page.getByRole("button", {
      name: new RegExp(`^${sequenceName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    });
    await expect(option).toBeVisible({ timeout: 5_000 });
    await option.evaluate((element) => (element as HTMLButtonElement).click());

    // DB: enrollment exists in active status
    await expect(async () => {
      const { data } = await admin
        .from("sequence_enrollments")
        .select("status")
        .eq("sequence_id", sequenceId)
        .eq("property_id", propertyId);
      expect(data).toHaveLength(1);
      expect(data![0].status).toBe("active");
    }).toPass({ timeout: 5_000 });
  });

  test("6. cancel an enrollment flips status to completed", async ({ page }) => {
    const admin = adminClient();
    const orgId = await seedOrgId();
    const { sequenceId } = await seedSequenceWithOneStep(admin, {
      name: `Flow-6 ${Date.now()}`,
      actionType: "change_status",
      targetStatus: "contacted",
      delayMinutes: 99999,
    });
    const { propertyId, contactId } = await seedLeadWithConsent(admin, {
      phone: "+18165559402",
    });

    // Direct-insert the enrollment so we skip the enroll UI (covered in test 5)
    await admin.from("sequence_enrollments").insert({
      org_id: orgId,
      sequence_id: sequenceId,
      property_id: propertyId,
      contact_id: contactId,
      status: "active",
      current_step_index: 0,
      next_run_at: new Date(Date.now() + 99 * 24 * 60 * 60_000).toISOString(),
    });

    await page.goto(`/leads/${propertyId}`);
    // Accept the confirm() dialog
    page.once("dialog", (d) => d.accept());
    // The widget's Cancel button lives inside the active-enrollments list.
    // Match by the text "Cancel" inside a row that references the sequence name.
    const enrollmentRow = page.locator("div", {
      hasText: /Flow-6/i,
    });
    await enrollmentRow
      .getByRole("button", { name: /^cancel$/i })
      .first()
      .click();
    await waitForSettled(page);

    await expect(async () => {
      const { data } = await admin
        .from("sequence_enrollments")
        .select("status")
        .eq("sequence_id", sequenceId);
      expect(data).toHaveLength(1);
      expect(data![0].status).toBe("completed");
    }).toPass({ timeout: 5_000 });
  });

  test("7. impact modal fires when editing a sequence that has enrollments", async ({
    page,
  }) => {
    const admin = adminClient();
    const orgId = await seedOrgId();
    const { sequenceId } = await seedSequenceWithOneStep(admin, {
      name: `Flow-7 ${Date.now()}`,
      body: "Hi {{first_name}}",
      delayMinutes: 99999,
    });
    const { propertyId, contactId } = await seedLeadWithConsent(admin, {
      phone: "+18165559403",
    });
    await admin.from("sequence_enrollments").insert({
      org_id: orgId,
      sequence_id: sequenceId,
      property_id: propertyId,
      contact_id: contactId,
      status: "active",
      current_step_index: 0,
      next_run_at: new Date(
        Date.now() + 2 * 24 * 60 * 60_000,
      ).toISOString(), // within 7 days → counts as "scheduled"
    });

    await page.goto(`/sequences/${sequenceId}/edit`);
    await page.getByLabel("Description").fill("Edited to trigger modal");

    // Intercept + assert on the confirm() message BEFORE the default
    // beforeEach handler auto-accepts. page.once("dialog") takes
    // precedence over page.on("dialog") for the same event.
    let capturedMessage: string | null = null;
    page.once("dialog", (d) => {
      capturedMessage = d.message();
      void d.accept();
    });

    // The first Save button in DOM order is the meta-form Save (the
    // per-step Save buttons appear below).
    await page.getByRole("button", { name: /^save$/i }).first().click();

    await expect(async () => {
      expect(capturedMessage).not.toBeNull();
    }).toPass({ timeout: 5_000 });
    expect(capturedMessage).toContain("1 lead enrolled");
    expect(capturedMessage).toContain("1 scheduled");

    await expect(async () => {
      const { data } = await admin
        .from("sequences")
        .select("description")
        .eq("id", sequenceId)
        .single();
      expect(data!.description).toBe("Edited to trigger modal");
    }).toPass({ timeout: 5_000 });
  });

  test("8. sidebar nav links all route correctly", async ({ page }) => {
    const admin = adminClient();
    await seedStarterLibrary(admin, await seedOrgId());

    await page.goto("/sequences");
    // Click through each visible primary nav item and assert the URL changes
    // (we can't easily assert the active-link class from Playwright without
    // more selectors, but landing on the page is the load-bearing check).
    const targets: Array<{ label: RegExp; path: RegExp }> = [
      { label: /^Leads$/, path: /\/leads/ },
      { label: /^Prospects$/, path: /\/properties/ },
      { label: /^Lists$/, path: /\/lists/ },
      { label: /^Sequences$/, path: /\/sequences/ },
      { label: /^Import$/, path: /\/import/ },
      { label: /^Messages$/, path: /\/messages/ },
      { label: /^Jobs$/, path: /\/jobs/ },
    ];
    for (const t of targets) {
      // Sidebar is semantic <nav aria-label="Primary">; target that to avoid
      // matching stray links in page content.
      const nav = page.getByRole("navigation", { name: "Primary" });
      await nav.getByRole("link", { name: t.label }).click();
      await expect(page).toHaveURL(t.path);
    }
  });
});
