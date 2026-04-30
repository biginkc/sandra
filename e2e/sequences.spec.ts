import { expect, test } from "@playwright/test";

import { seedStarterLibrary } from "../src/lib/sequences/starter-library";

import { adminClient, ensureTestUser, resetTenantTables } from "./fixtures";

/**
 * Feature 5a — Sequences V1 smoke. Exercises the full stack:
 *   1. /sequences index renders the migration-seeded starter library
 *      (4 sequences, since the 5th deferred with assign_task).
 *
 * The new-sequence form-interaction half migrated to RTL —
 * `src/app/(dashboard)/sequences/new/form.test.tsx`. The createSequence
 * server-action half is covered by a Vitest Node-env test —
 * `src/app/(dashboard)/sequences/actions.test.ts`.
 *
 * Deeper flows (enroll-from-lead-detail, edit-template + impact modal,
 * drip chip on kanban card) are covered via the integration suite
 * against a real DB; this E2E test is the browser-layer safety net for
 * the Server-Component starter-library render.
 */

test("/sequences index renders the starter library after org-level re-seed", async ({
  page,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  await ensureTestUser(admin);

  // Re-seed the starter library for the org (reset truncated sequences).
  const { data: org } = await admin
    .from("organizations")
    .select("id")
    .limit(1)
    .single();
  await seedStarterLibrary(admin, org!.id);

  await page.goto("/sequences");
  await expect(page.getByRole("heading", { name: "Sequences" })).toBeVisible();
  await expect(page.getByText("First touch new lead")).toBeVisible();
  await expect(page.getByText("Nurture cold lead")).toBeVisible();
  await expect(page.getByText("Nurture not-interested")).toBeVisible();
  await expect(page.getByText("Dead lead requalify")).toBeVisible();
});
