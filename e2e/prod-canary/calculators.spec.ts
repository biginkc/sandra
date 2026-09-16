import { expect, test, type Page } from "@playwright/test";

import fixtures from "../../src/lib/calculators/worksheet-fixtures.json";
import {
  insertCanaryProspect,
  pollUntil,
  requireProdCanaryEnv,
  requireProdCanarySupabase,
  resolveAuthUserId,
  resolvePrimaryMembershipOrgId,
} from "./support";

type UntypedRow = Record<string, unknown>;
type UntypedResult = { data: UntypedRow[] | null; error: { message: string } | null };
type UntypedSingleResult = { data: UntypedRow | null; error: { message: string } | null };
type UntypedQuery = PromiseLike<UntypedResult> & {
  eq(column: string, value: unknown): UntypedQuery;
  is(column: string, value: unknown): UntypedQuery;
  limit(value: number): UntypedQuery;
  maybeSingle(): Promise<UntypedSingleResult>;
  order(column: string, options?: { ascending?: boolean }): UntypedQuery;
  select(columns?: string): UntypedQuery;
  update(values: Record<string, unknown>): UntypedQuery;
};

function table(client: ReturnType<typeof requireProdCanarySupabase>, name: string): UntypedQuery {
  return (client as unknown as { from(tableName: string): UntypedQuery }).from(name);
}

const INPUT_LABELS = {
  asIs: "As-is market value",
  profit: "Desired profit",
  flatFee: "Flat-fee listing",
  attorney: "Attorney",
  titleInsurance: "Title insurance",
  efile: "E-file",
  recording: "Recording",
  taxStamps: "Tax / stamps",
  pictures: "Pictures",
  other: "Other expenses",
  repairs: "Buyer-requested repairs",
  arv: "ARV (after-repair value)",
  rehab: "Investor rehab",
} as const;

const OUTPUTS = [
  ["result-commission", "B5"],
  ["result-listing", "B26"],
  ["result-equity", "B17"],
  ["result-family", "B19"],
  ["result-secure", "B21"],
  ["result-rapid", "B23"],
  ["result-fee40000", "E21"],
  ["result-fee30000", "E22"],
  ["result-fee20000", "E23"],
  ["result-fee10000", "E24"],
  ["result-investor", "E26"],
] as const;

const dollars = (value: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value);

async function enterFixture(
  page: Page,
  input: (typeof fixtures)[number]["inputs"],
): Promise<void> {
  for (const [key, label] of Object.entries(INPUT_LABELS)) {
    const value = input[key as keyof typeof input];
    await page.getByRole("textbox", { name: label, exact: true }).fill(
      value === null ? "" : String(value),
    );
  }

  await page.getByRole("button", { name: "Unlock listing percentage", exact: true }).click();
  const listing = page.getByRole("textbox", { name: "Listing percentage", exact: true });
  await expect(listing).toBeVisible();
  await listing.fill(input.listingPercentage === null ? "" : String(input.listingPercentage * 100));
  await page.getByRole("button", { name: "Lock listing percentage", exact: true }).click();
}

async function softDeleteOwnedCanaryLead(
  client: ReturnType<typeof requireProdCanarySupabase>,
  input: { address: string; orgId: string; runId: string },
): Promise<void> {
  if (!input.address.includes("PROD-CANARY")) {
    throw new Error("Refusing calculator cleanup for an address without PROD-CANARY.");
  }

  const expectedNotes = `Created by production Playwright canary ${input.runId}`;
  const rows = await table(client, "properties")
    .select("id, address, org_id, notes, deleted_at")
    .eq("address", input.address);
  if (rows.error) throw new Error(`Could not look up calculator canary lead: ${rows.error.message}`);

  for (const row of rows.data ?? []) {
    if (
      row.address !== input.address ||
      row.org_id !== input.orgId ||
      row.notes !== expectedNotes
    ) {
      throw new Error("Refusing cleanup because the calculator canary lead guard did not match.");
    }
    const result = await table(client, "properties")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", row.id)
      .eq("address", input.address)
      .eq("org_id", input.orgId)
      .eq("notes", expectedNotes)
      .is("deleted_at", null);
    if (result.error) throw new Error(`Could not soft-delete calculator canary lead: ${result.error.message}`);
  }
}

test.describe("production calculator canary", () => {
  test.describe.configure({ mode: "serial" });

  let env: ReturnType<typeof requireProdCanaryEnv>;
  let supabase: ReturnType<typeof requireProdCanarySupabase>;
  let userId: string;
  let orgId: string;
  let address: string;
  let leadId: string;
  let runId: string;

  test.beforeAll(async () => {
    env = requireProdCanaryEnv();
    supabase = requireProdCanarySupabase();
    userId = await resolveAuthUserId(supabase, env.email);
    orgId = await resolvePrimaryMembershipOrgId(supabase, userId);
    runId = env.runId.replace(/[^a-zA-Z0-9-]/g, "-");
    address = `${env.label} Calculator ${runId} 901 Calculator Ct`;

    const membership = await table(supabase, "memberships")
      .select("role, access_status, access_expires_at, deletion_prepared_at, acquisitions_enabled")
      .eq("org_id", orgId)
      .eq("user_id", userId)
      .maybeSingle();
    if (membership.error) throw new Error(`Could not verify calculator membership: ${membership.error.message}`);
    expect(membership.data).toEqual(expect.objectContaining({ access_status: "active" }));
    expect(membership.data?.role === "owner" || membership.data?.acquisitions_enabled === true).toBe(true);
    expect(membership.data?.deletion_prepared_at ?? null).toBeNull();
    expect(membership.data?.access_expires_at == null || new Date(String(membership.data.access_expires_at)) > new Date()).toBe(true);

    const settings = await table(supabase, "acquisition_org_settings")
      .select("my_leads_enabled")
      .eq("org_id", orgId)
      .maybeSingle();
    if (settings.error) throw new Error(`Could not verify calculator workflow setting: ${settings.error.message}`);
    expect(settings.data?.my_leads_enabled).toBe(true);

    // A rerun with an explicitly reused PROD_CANARY_RUN_ID may find its old
    // property. Retain its snapshots and make only the owned lead invisible.
    await softDeleteOwnedCanaryLead(supabase, { address, orgId, runId: env.runId });
    const lead = await insertCanaryProspect(supabase, {
      address,
      runId: env.runId,
      fields: {
        ai_responder_disabled: true,
        org_id: orgId,
        status: "new_lead",
      },
    });
    leadId = lead.id;
    const assignment = await supabase
      .from("properties")
      .update({ assigned_user_id: userId })
      .eq("id", leadId)
      .eq("org_id", orgId)
      .eq("address", address);
    if (assignment.error) throw new Error(`Could not assign calculator canary lead: ${assignment.error.message}`);
  });

  test.afterAll(async () => {
    if (!supabase || !address || !orgId || !runId) return;
    await softDeleteOwnedCanaryLead(supabase, { address, orgId, runId: env.runId });
  });

  test("matches all six worksheet fixtures, attaches an owned lead, retries a lost save, and reopens revisions", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    testInfo.annotations.push({ type: "runId", description: env.runId });

    const baseline = await table(supabase, "properties")
      .select("id, status, assigned_user_id, ai_responder_disabled, deleted_at")
      .eq("id", leadId)
      .maybeSingle();
    if (baseline.error || !baseline.data) throw new Error(`Could not read seeded calculator lead: ${baseline.error?.message ?? "missing row"}`);
    expect(baseline.data.status).toBe("new_lead");
    expect(baseline.data.assigned_user_id).toBe(userId);
    expect(baseline.data.ai_responder_disabled).toBe(true);
    expect(baseline.data.deleted_at ?? null).toBeNull();

    await page.goto("/calculators");
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByRole("heading", { name: "Offer Calculator", exact: true })).toBeVisible({ timeout: 20_000 });

    for (const fixture of fixtures) {
      await enterFixture(page, fixture.inputs);
      for (const [testId, cell] of OUTPUTS) {
        await expect(page.getByTestId(testId)).toHaveText(dollars(fixture.worksheet[cell]));
      }
    }

    // Explicit acceptance scenario: the production UI must preserve the
    // worksheet's wholesale anchors for ARV $350,000 and investor rehab
    // $50,000, independent of the six source worksheet fixtures above.
    const acceptanceInputs = {
      asIs: 175000,
      listingPercentage: 0.9,
      profit: 20000,
      flatFee: 150,
      attorney: 995,
      titleInsurance: 500,
      efile: 35,
      recording: 25,
      taxStamps: 200,
      pictures: 300,
      other: 500,
      repairs: 0,
      arv: 350000,
      rehab: 50000,
    } as (typeof fixtures)[number]["inputs"];
    await enterFixture(page, acceptanceInputs);
    await expect(page.getByTestId("result-arv70")).toHaveText(dollars(245000));
    await expect(page.getByTestId("result-investor")).toHaveText(dollars(195000));
    await expect(page.getByTestId("result-fee40000")).toHaveText(dollars(155000));
    await expect(page.getByTestId("result-fee30000")).toHaveText(dollars(165000));
    await expect(page.getByTestId("result-fee20000")).toHaveText(dollars(175000));
    await expect(page.getByTestId("result-fee10000")).toHaveText(dollars(185000));

    await page.getByRole("button", { name: "Attach a lead", exact: true }).click();
    const search = page.getByRole("textbox", { name: "Search leads by address or name", exact: true });
    await search.fill(runId);
    const leadButton = page.getByRole("button", { name: new RegExp(address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });
    await expect(leadButton).toBeVisible({ timeout: 20_000 });
    await leadButton.click();
    await expect(page.getByTestId("attached-lead")).toContainText(address);

    const proposedOffer = 222222.22;
    await page.getByRole("textbox", { name: "Proposed offer", exact: true }).fill(String(proposedOffer));
    await page.getByRole("textbox", { name: "Terms", exact: true }).fill("cash close in 21 days");
    await page.getByRole("textbox", { name: "Seller motivation", exact: true }).fill("relocation");

    // The first save reaches the production server, then its browser response
    // is deliberately lost. Only this armed save POST carrying Next's action
    // header and this lead ID is fetched upstream and aborted; search/navigation requests pass.
    let interceptionArmed = false;
    let interceptedSave = false;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (
        interceptionArmed &&
        !interceptedSave &&
        request.method() === "POST" &&
        url.pathname === "/calculators" &&
        Boolean(request.headers()["next-action"]) &&
        Boolean(request.postData()?.includes(leadId))
      ) {
        interceptedSave = true;
        interceptionArmed = false;
        await route.fetch();
        await route.abort("connectionreset");
        return;
      }
      await route.continue();
    });

    interceptionArmed = true;
    await page.getByRole("button", { name: "Save to lead", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("entries are still here", { timeout: 20_000 });
    expect(interceptedSave).toBe(true);

    await page.getByRole("button", { name: "Retry save", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Saved revision v1", { timeout: 20_000 });

    const firstRows = await pollUntil(
      async () => {
        const result = await table(supabase, "offer_calculations")
          .select("*")
          .eq("property_id", leadId)
          .order("version", { ascending: true });
        if (result.error) throw new Error(`Could not read saved calculator snapshot: ${result.error.message}`);
        return result.data?.length ? result.data : null;
      },
      { label: "calculator v1 persisted", timeoutMs: 20_000 },
    );
    expect(firstRows).toHaveLength(1);
    const first = firstRows[0];
    expect(first.version).toBe(1);
    expect(first.property_id).toBe(leadId);
    expect(first.created_by).toBe(userId);
    expect(first.worksheet_sha256).toBe("1017cc7835ae7f41a8d32e3228b9510fe01697c4a018f22b86df7c1061a4bdf8");
    expect(first.decision).toMatchObject({ proposedOffer, terms: "cash close in 21 days", motivation: "relocation" });
    expect(first.provenance).toEqual({ source: "lead_search", leadId });
    expect((first.inputs as UntypedRow).listingPercentage).toBe(fixtures[fixtures.length - 1].inputs.listingPercentage);

    await page.goto(`/leads/${leadId}`);
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByRole("heading", { name: address })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("lead-activity-timeline")).toBeVisible({ timeout: 20_000 });
    const firstEvent = page.getByTestId("lead-event-row").filter({ hasText: /saved novation calculation v1/ });
    await expect(firstEvent).toContainText("proposed $222,222.22");
    await firstEvent.getByRole("link", { name: "Open calculation", exact: true }).click();

    await expect(page.getByRole("heading", { name: "Offer calculation · v1", exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Read-only saved inputs and results")).toBeVisible();
    await page.getByRole("link", { name: "Create a new version", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/calculators\\?calculationId=${String(first.id)}`));
    await expect(page.getByTestId("attached-lead")).toContainText(address);
    await page.getByRole("textbox", { name: "Buyer-requested repairs", exact: true }).fill("5000");
    await page.getByRole("button", { name: "Save to lead", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Saved revision v2", { timeout: 20_000 });

    const snapshots = await pollUntil(
      async () => {
        const result = await table(supabase, "offer_calculations")
          .select("*")
          .eq("property_id", leadId)
          .order("version", { ascending: true });
        if (result.error) throw new Error(`Could not read calculator revisions: ${result.error.message}`);
        return result.data?.length === 2 ? result.data : null;
      },
      { label: "calculator v2 persisted", timeoutMs: 20_000 },
    );
    expect(snapshots.map((row) => row.version)).toEqual([1, 2]);
    expect(snapshots[1].parent_id).toBe(snapshots[0].id);
    expect(snapshots[1].series_id).toBe(snapshots[0].series_id);
    expect((snapshots[1].inputs as UntypedRow).repairs).toBe(5000);

    await page.goto(`/leads/${leadId}`);
    await expect(page.getByTestId("lead-activity-timeline")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("lead-event-row").filter({ hasText: /saved novation calculation v1/ })).toBeVisible();
    await expect(page.getByTestId("lead-event-row").filter({ hasText: /saved novation calculation v2/ })).toBeVisible();

    const unchangedLead = await table(supabase, "properties")
      .select("status, assigned_user_id, ai_responder_disabled, deleted_at")
      .eq("id", leadId)
      .maybeSingle();
    if (unchangedLead.error || !unchangedLead.data) throw new Error(`Could not verify calculator lead state: ${unchangedLead.error?.message ?? "missing row"}`);
    expect(unchangedLead.data).toEqual({
      status: baseline.data.status,
      assigned_user_id: baseline.data.assigned_user_id,
      ai_responder_disabled: baseline.data.ai_responder_disabled,
      deleted_at: null,
    });

    const messages = await table(supabase, "messages").select("id").eq("property_id", leadId);
    if (messages.error) throw new Error(`Could not verify no provider activity: ${messages.error.message}`);
    expect(messages.data).toEqual([]);
  });
});
