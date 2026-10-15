import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { adminClient, DEFAULT_ORG_ID, E2E_MOCK_BUSINESS_NUMBER, seedProspects } from "./fixtures";

/**
 * /messages-v2: Sandra's tape, the "Waiting for a person" column and the
 * "Sandra's rules" panel. The shared test user is an org owner, which passes
 * the Messages v2 gate.
 *
 * The first block asserts page structure and plain-English invariants on
 * whatever is on the page. The second block seeds its own rows (a decided run
 * and three flagged properties, one of them permanently do-not-contact locked)
 * and skips with a reason if the test project cannot take them.
 */

const TAG_VOCABULARY = [
  "Wants an offer",
  "Talked price",
  "Maybe later",
  "Not interested",
  "Wrong person",
  "Asked to stop",
  "Hostile",
  "Can't read it",
  "Waits for a person",
];
const ENGINE_WORDS = ["reply_delay_scheduled", "resolve_threshold", "needs_attention", "luna_suggest", "gates passed", "gate passed"];

test.describe("/messages-v2 page face", () => {
  test("renders the one-line header, the tape and the waiting column", async ({ page }) => {
    await page.goto("/messages-v2");

    await expect(page.getByRole("heading", { name: "Messages v2" })).toBeVisible();
    await expect(page.getByTestId("header-status")).toContainText(/Sandra is (on|watching)/);
    await expect(page.getByLabel("Sandra's tape", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Waiting for a person", { exact: true })).toBeVisible();
    // The old face is gone.
    await expect(page.getByLabel("Shadow scorecard", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Legend", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Live feed", { exact: true })).toHaveCount(0);
    await expect(page.locator("main")).not.toContainText(/\bJev\b/);
  });

  test("the Sandra's rules button opens a side panel grouped by who acts", async ({ page }) => {
    await page.goto("/messages-v2");
    await page.getByTestId("open-rules").click();
    const panel = page.getByTestId("rules-panel");
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("heading", { name: "Becomes a lead" })).toBeVisible();
    await expect(panel.getByRole("heading", { name: "Sandra handles alone" })).toBeVisible();
    await expect(panel.getByRole("heading", { name: "Waits for a person" })).toBeVisible();
    await expect(panel).not.toContainText(/\bJev\b/);
  });

});

test.describe("/messages-v2 seeded rows", () => {
  const tag = `MV2${randomUUID().slice(0, 6)}`;
  const ids = { properties: [] as string[], contacts: [] as string[], messages: [] as string[], runs: [] as string[] };
  let seedError: string | null = null;
  const addr = (n: number) => `${tag} ${n} Golden Path Ln`;

  // Skipping is allowed only when this machine has no Supabase test env at all. In CI a failed seed must fail loudly.
  const hasTestEnv = Boolean(
    (process.env.TEST_SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL) &&
      (process.env.TEST_SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY),
  );
  const requireSeed = () => {
    if (seedError === null) return;
    if (process.env.CI || hasTestEnv) throw new Error(`messages-v2 seeding failed: ${seedError}`);
    test.skip(true, `no Supabase test env: ${seedError}`);
  };

  test.beforeAll(async () => {
    try {
      const admin = adminClient();
      // One decided run: Martha said no, Sandra replied and closed it.
      const { data: contact, error: contactError } = await admin
        .from("contacts")
        .insert({ first_name: `Martha${tag}`, last_name: "Test", phone_1: `+1816555${Math.floor(1000 + Math.random() * 8999)}`, phone_1_type: "mobile" })
        .select("id")
        .single();
      if (contactError || !contact) throw contactError ?? new Error("contact seed failed");
      ids.contacts.push(contact.id);
      const [decidedProp] = await seedProspects(admin, 1, `${tag} decided`);
      ids.properties.push(decidedProp.id);
      const { data: inbound, error: msgError } = await admin
        .from("messages")
        .insert({
          channel: "sms",
          direction: "inbound",
          status: "received",
          contact_id: contact.id,
          property_id: decidedProp.id,
          from_address: "+18165550100",
          to_address: E2E_MOCK_BUSINESS_NUMBER,
          body: "The house is sold.",
        })
        .select("id")
        .single();
      if (msgError || !inbound) throw msgError ?? new Error("message seed failed");
      ids.messages.push(inbound.id);
      const { data: run, error: runError } = await admin
        .from("pipeline_runs" as never)
        .insert({
          org_id: DEFAULT_ORG_ID,
          inbound_message_id: inbound.id,
          property_id: decidedProp.id,
          contact_id: contact.id,
          status: "closed",
          mode: "automatic",
          inbound_preview: "The house is sold.",
        } as never)
        .select("id")
        .single();
      const runRow = run as { id: string } | null;
      if (runError || !runRow) throw runError ?? new Error("run seed failed");
      ids.runs.push(runRow.id);
      const steps = [
        { kind: "jev", name: "classify", result: "pass", detail: { outcome: "not_interested" } },
        { kind: "action", name: "not_interested", result: "applied", detail: {} },
        { kind: "reply", name: "template_reply", result: "sent", detail: {} },
      ].map((s, i) => ({ ...s, run_id: runRow.id, org_id: DEFAULT_ORG_ID, seq: i + 1 }));
      const { error: stepError } = await admin.from("pipeline_run_steps" as never).insert(steps as never);
      if (stepError) throw stepError;

      // Three flagged properties, flagged one after another: [1] oldest, [2] newest, [3] locked.
      const flagged = await seedProspects(admin, 3, tag);
      ids.properties.push(...flagged.map((p) => p.id));
      for (const [i, p] of flagged.entries()) {
        const { error } = await admin
          .from("properties")
          .update({
            needs_human_attention: true,
            last_ai_escalation_at: new Date(Date.now() + i * 1500).toISOString(),
            last_ai_escalation_reason: "model:unclear",
            ...(i === 2 ? { is_dnc_locked: true } : {}),
          })
          .eq("id", p.id);
        if (error) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1200));
      }
    } catch (error) {
      seedError = error instanceof Error ? error.message : JSON.stringify(error);
    }
  });

  test.afterAll(async () => {
    if (!hasTestEnv) return;
    const admin = adminClient();
    if (ids.runs.length) await admin.from("pipeline_runs" as never).delete().in("id", ids.runs);
    if (ids.messages.length) await admin.from("messages").delete().in("id", ids.messages);
    if (ids.properties.length) await admin.from("properties").delete().in("id", ids.properties);
    if (ids.contacts.length) await admin.from("contacts").delete().in("id", ids.contacts);
  });

  test("a decided card shows the seller's text, a vocabulary tag and one plain sentence", async ({ page }) => {
    requireSeed();
    await page.goto("/messages-v2");
    const card = page.getByTestId("tape-card").filter({ hasText: "The house is sold." });
    await expect(card).toBeVisible();
    await expect(card.getByTestId("tape-tag")).toHaveText("Not interested");
    await expect(card.getByTestId("tape-sentence")).toContainText(/Sandra: Martha\w* said no\./);
    await expect(card.getByTestId("tape-did")).toContainText("Reply sent");
  });

  test("waiting column lists the newest flag first and hides the do-not-contact locked property", async ({ page }) => {
    requireSeed();
    await page.goto("/messages-v2");
    const column = page.getByTestId("waiting-column");
    await expect(column.getByText(addr(2), { exact: false })).toBeVisible();
    await expect(column.getByText(addr(1), { exact: false })).toBeVisible();
    await expect(column.getByText(addr(3), { exact: false })).toHaveCount(0);
    const text = await column.innerText();
    expect(text.indexOf(addr(2))).toBeLessThan(text.indexOf(addr(1)));
  });

  test("tape cards (at least one) use plain sentences and tags from the vocabulary, never engine words", async ({ page }) => {
    requireSeed();
    await page.goto("/messages-v2");
    const decided = page.locator('[data-testid="tape-card"][data-kind="decided"]');
    await expect(decided.first()).toBeVisible();
    const count = await decided.count();
    expect(count, "no decided tape cards rendered: the seed did not reach the page").toBeGreaterThan(0);
    for (let i = 0; i < Math.min(count, 10); i += 1) {
      const card = decided.nth(i);
      await expect(card.getByTestId("tape-sentence")).toContainText("Sandra:");
      const tag = card.getByTestId("tape-tag");
      if (await tag.count()) expect(TAG_VOCABULARY).toContain((await tag.innerText()).trim());
      const text = await card.innerText();
      for (const word of ENGINE_WORDS) expect(text).not.toContain(word);
    }
  });

  test("the waiting column (at least two cards) is never oldest-first", async ({ page }) => {
    requireSeed();
    await page.goto("/messages-v2");
    await expect(page.getByTestId("waiting-card").nth(1)).toBeVisible();
    const times = await page.getByTestId("waiting-time").locator("time").evaluateAll((els) => els.map((el) => el.getAttribute("datetime") ?? ""));
    const stamps = times.filter(Boolean).map((t) => Date.parse(t));
    expect(stamps.length, "fewer than two waiting cards rendered: the seed did not reach the page").toBeGreaterThan(1);
    expect(stamps).toEqual([...stamps].sort((a, b) => b - a));
  });
});
