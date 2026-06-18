import { expect, test } from "@playwright/test";

import { normalizeAddress } from "../../src/lib/csv/normalize";

import {
  deleteCanaryPropertiesByAddressPrefix,
  deleteCanaryUpdateJobsByFilename,
  insertCanaryProspects,
  pollUntil,
  requireProdCanaryEnv,
  requireProdCanarySupabase,
  resolveAuthUserId,
  resolvePrimaryMembershipOrgId,
} from "./support";

test("production canary updates existing canary properties through import update mode", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);

  const env = requireProdCanaryEnv();
  const supabase = requireProdCanarySupabase();
  const canaryUserId = await resolveAuthUserId(supabase, env.email);
  const canaryOrgId = await resolvePrimaryMembershipOrgId(supabase, canaryUserId);
  const token = env.runId.replace(/[^a-zA-Z0-9-]/g, "-");
  const prefix = `${env.label} Import Update ${token}`;
  const filename = `${env.label} import update ${token}.csv`;
  testInfo.annotations.push({ type: "runId", description: env.runId });

  const addresses = [
    `${prefix} 501 Update St`,
    `${prefix} 502 Update St`,
    `${prefix} 503 Update St`,
  ];
  const csv = [
    "Address,Status",
    `"${addresses[0]}",contacted`,
    `"${addresses[1]}",interested`,
    `"${prefix} 999 Missing St",offer_sent`,
  ].join("\n");

  await deleteCanaryUpdateJobsByFilename(supabase, filename);
  await deleteCanaryPropertiesByAddressPrefix(supabase, prefix);

  try {
    const seeded = await insertCanaryProspects(
      supabase,
      addresses.map((address) => ({
        address,
        runId: env.runId,
        fields: {
          address_normalized: normalizeAddress(address),
          org_id: canaryOrgId,
          status: "new_lead",
        },
      })),
    );

    await page.goto("/import");
    await expect(page).not.toHaveURL(/\/login/);
    await page.getByTestId("mode-update").click();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await page.getByTestId("subop-update-property-status").click();
    await page.getByRole("button", { name: "Next", exact: true }).click();

    await page.locator("input#update-file").setInputFiles({
      name: filename,
      mimeType: "text/csv",
      buffer: Buffer.from(csv, "utf8"),
    });
    await expect(page.getByRole("main").getByText(filename)).toBeVisible({
      timeout: 10_000,
    });

    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.getByText(/will update.*2 rows/i)).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText(/couldn.t match.*1 rows/i)).toBeVisible();

    await page.getByRole("button", { name: /confirm & apply/i }).click();
    await expect(page.getByText(/update started/i)).toBeVisible({
      timeout: 20_000,
    });

    const job = await pollUntil(
      async () => {
        const { data, error } = await supabase
          .from("jobs")
          .select("id, status, total_items, succeeded_items, failed_items")
          .eq("type", "csv_update")
          .eq("title", `Update ${filename}`)
          .maybeSingle();
        expect(error).toBeNull();
        if (!data) return null;
        return ["completed", "partial", "failed"].includes(data.status)
          ? data
          : null;
      },
      { label: "terminal canary update job", timeoutMs: 45_000 },
    );
    expect(job.status).toBe("completed");
    expect(job.total_items).toBe(3);
    expect(job.succeeded_items).toBe(2);
    expect(job.failed_items).toBe(1);

    await expect(async () => {
      const { data, error } = await supabase
        .from("properties")
        .select("id, address, status")
        .in(
          "id",
          seeded.map((row) => row.id),
        );
      expect(error).toBeNull();
      const byAddress = new Map((data ?? []).map((row) => [row.address, row.status]));
      expect(byAddress.get(addresses[0])).toBe("contacted");
      expect(byAddress.get(addresses[1])).toBe("interested");
      expect(byAddress.get(addresses[2])).toBe("new_lead");
    }).toPass({ timeout: 20_000 });

  } finally {
    await deleteCanaryPropertiesByAddressPrefix(supabase, prefix);
    await deleteCanaryUpdateJobsByFilename(supabase, filename);
  }
});
