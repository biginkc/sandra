import { expect, test } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";

import { normalizeAddress } from "../../src/lib/csv/normalize";
import type { Database } from "../../src/lib/supabase/types";

import {
  deleteCanaryPropertiesByAddressPrefix,
  deleteCanaryUpdateJobsByFilename,
  insertCanaryProspects,
  pollUntil,
  requireProdCanaryEnv,
  requireProdCanarySupabase,
} from "./support";

async function resolveAuthUserId(
  client: SupabaseClient<Database>,
  email: string,
): Promise<string> {
  const { data, error } = await client.auth.admin.listUsers();
  if (error) {
    throw new Error(`Could not list production canary auth users: ${error.message}`);
  }
  const user = data.users.find(
    (candidate) => candidate.email?.toLowerCase() === email.toLowerCase(),
  );
  if (!user) {
    throw new Error(`Could not resolve production canary user id for ${email}.`);
  }
  return user.id;
}

async function resolvePrimaryMembershipOrgId(
  client: SupabaseClient<Database>,
  userId: string,
): Promise<string> {
  const { data, error } = await client
    .from("memberships")
    .select("org_id, role")
    .eq("user_id", userId)
    .limit(2);
  if (error) {
    throw new Error(`Could not resolve production canary membership: ${error.message}`);
  }
  if (!data || data.length !== 1) {
    throw new Error(
      `Expected exactly one production canary membership, found ${data?.length ?? 0}.`,
    );
  }
  return data[0].org_id;
}

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
