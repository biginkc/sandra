import { test, expect } from "@playwright/test";

import { adminClient, resetTenantTables } from "./fixtures";

/**
 * Smoke test for the skip-trace retry button on /jobs/[id]. Seeds a
 * failed `skip_trace` job that mirrors the pre-#59 production state
 * (failed_items > 0, no `job_items` rows, property_ids on
 * `input_params`) and verifies:
 *   1. The button renders with the fallback property count.
 *   2. The confirmation dialog shows the correct count + cost.
 *   3. Cancelling does not create a child job.
 *
 * Does NOT click "Retry" — the action calls `runSkipTraceEnrichment`
 * which would hit Tracerfy. The unit/integration tests cover the
 * retryFailedSkipTraceItems action's child-creation behaviour.
 */
test.describe("/jobs/[id] retry button", () => {
  test("renders retry button for a failed skip_trace job and shows cost in dialog", async ({
    page,
  }) => {
    const admin = adminClient();
    await resetTenantTables(admin);

    // Seed three properties + a failed skip_trace job pointing at them
    // with no job_items rows — the pre-#59 recovery shape.
    const orgRes = await admin.from("organizations").select("id").limit(1).single();
    const orgId = orgRes.data!.id;

    const propIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { data } = await admin
        .from("properties")
        .insert({ address: `${i + 1} Retry St`, state: "MO", status: "prospect" })
        .select("id")
        .single();
      propIds.push(data!.id);
    }

    const { data: jobRow } = await admin
      .from("jobs")
      .insert({
        type: "skip_trace",
        provider: "tracerfy",
        status: "failed",
        org_id: orgId,
        total_items: 3,
        processed_items: 3,
        failed_items: 3,
        title: "Skip trace 3 properties",
        input_params: { property_ids: propIds },
      })
      .select("id")
      .single();
    const jobId = jobRow!.id;

    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto(`/jobs/${jobId}`);

    // Page rendered, no error boundary.
    await expect(page.locator("text=Something went wrong.")).toHaveCount(0);

    // Button visible with the fallback count from input_params.property_ids.
    // Pre-#59 jobs (no job_items at all) use the input_params count as
    // the retryable count — same as the count shown in the button label.
    const retry = page.getByRole("button", { name: /^Retry 3 retryable$/ });
    await expect(retry).toBeVisible();

    // Open the dialog and check copy.
    await retry.click();
    await expect(page.getByRole("heading", { name: "Retry skip-trace?" })).toBeVisible();
    await expect(page.getByText(/Estimated cost: \$0\.06/)).toBeVisible();

    // Cancel — no new child job should exist.
    await page.getByRole("button", { name: "Cancel" }).click();
    const { data: children } = await admin
      .from("jobs")
      .select("id")
      .eq("parent_job_id", jobId);
    expect(children ?? []).toHaveLength(0);

    expect(errors, errors.join("\n")).toHaveLength(0);
  });

  test("classifies error rows by error_class and hides button when all errors are terminal", async ({
    page,
  }) => {
    const admin = adminClient();
    await resetTenantTables(admin);
    const orgRes = await admin.from("organizations").select("id").limit(1).single();
    const orgId = orgRes.data!.id;

    const propIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const { data } = await admin
        .from("properties")
        .insert({
          address: `${i + 1} Terminal Ln`,
          state: "MO",
          status: "prospect",
          cass_status: "verified",
        })
        .select("id")
        .single();
      propIds.push(data!.id);
    }

    const { data: jobRow } = await admin
      .from("jobs")
      .insert({
        type: "skip_trace",
        provider: "tracerfy",
        status: "failed",
        org_id: orgId,
        total_items: 2,
        processed_items: 2,
        failed_items: 2,
        title: "Terminal-only failure",
        input_params: { property_ids: propIds },
      })
      .select("id")
      .single();

    // Both errors are terminal — should hide the retry button.
    await admin.from("job_items").insert([
      {
        job_id: jobRow!.id,
        property_id: propIds[0],
        status: "error",
        error_class: "provider_no_data",
        error_message: "Provider has no owner data for this address.",
      },
      {
        job_id: jobRow!.id,
        property_id: propIds[1],
        status: "error",
        error_class: "address_unverified",
        error_message: "Address not USPS-verified.",
      },
    ]);

    await page.goto(`/jobs/${jobRow!.id}`);

    // Retry button should not appear: zero retryable items.
    await expect(
      page.getByRole("button", { name: /^Retry/ }),
    ).toHaveCount(0);

    // The error_class badges should render in the items table.
    await expect(page.getByText("No data at vendor").first()).toBeVisible();
    await expect(page.getByText("CASS unverified").first()).toBeVisible();
  });

  test("hides retry button on a completed skip_trace job", async ({ page }) => {
    const admin = adminClient();
    await resetTenantTables(admin);
    const orgRes = await admin.from("organizations").select("id").limit(1).single();
    const orgId = orgRes.data!.id;
    const { data: prop } = await admin
      .from("properties")
      .insert({ address: "1 Done Ln", state: "MO", status: "prospect" })
      .select("id")
      .single();
    const { data: jobRow } = await admin
      .from("jobs")
      .insert({
        type: "skip_trace",
        provider: "tracerfy",
        status: "completed",
        org_id: orgId,
        total_items: 1,
        processed_items: 1,
        failed_items: 0,
        title: "Skip trace 1 property",
        input_params: { property_ids: [prop!.id] },
      })
      .select("id")
      .single();

    await page.goto(`/jobs/${jobRow!.id}`);
    await expect(
      page.getByRole("button", { name: /^Retry/ }),
    ).toHaveCount(0);
  });
});
