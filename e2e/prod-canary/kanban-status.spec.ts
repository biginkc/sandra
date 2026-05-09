import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  deleteCanaryPropertiesByAddress,
  insertCanaryProspect,
  pollUntil,
  requireProdCanaryEnv,
  requireProdCanarySupabase,
} from "./support";

async function dragLeadToColumn(
  page: Page,
  card: Locator,
  targetColumn: Locator,
) {
  const cardBox = await card.boundingBox();
  const targetBox = await targetColumn.boundingBox();
  if (!cardBox || !targetBox) {
    throw new Error("Could not resolve lead card or target column bounding box.");
  }

  await page.mouse.move(
    cardBox.x + cardBox.width / 2,
    cardBox.y + cardBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    cardBox.x + cardBox.width / 2 + 20,
    cardBox.y + cardBox.height / 2 + 20,
    { steps: 5 },
  );
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + 80, {
    steps: 15,
  });
  await page.mouse.up();
}

test("production canary moves a canary lead between Kanban statuses", async ({
  page,
}, testInfo) => {
  const env = requireProdCanaryEnv();
  const supabase = requireProdCanarySupabase();
  const token = env.runId.replace(/[^a-zA-Z0-9-]/g, "-");
  const address = `${env.label} Kanban ${token} 601 Birch St`;
  testInfo.annotations.push({ type: "runId", description: env.runId });

  await page.addInitScript(() => {
    window.localStorage.removeItem("sandra.leads.collapsed");
    window.localStorage.removeItem("sandra.leads.mineOnly");
    window.localStorage.removeItem("sandra.leads.motivationFilter");
  });
  await deleteCanaryPropertiesByAddress(supabase, address);

  try {
    const lead = await insertCanaryProspect(supabase, {
      address,
      runId: env.runId,
      fields: {
        status: "new_lead",
        cass_status: "verified",
      },
    });

    await page.goto("/leads");
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByRole("heading", { name: "Leads" })).toBeVisible({
      timeout: 20_000,
    });

    await page.getByRole("textbox", { name: /search leads/i }).fill(token);
    const card = page.getByText(address).first();
    await expect(card).toBeVisible({ timeout: 20_000 });

    const contactedColumn = page
      .locator("div")
      .filter({ hasText: /^Contacted/ })
      .first();
    await expect(contactedColumn).toBeVisible();

    await dragLeadToColumn(page, card, contactedColumn);

    await pollUntil(
      async () => {
        const { data, error } = await supabase
          .from("properties")
          .select("id, address, status")
          .eq("id", lead.id)
          .maybeSingle();
        expect(error).toBeNull();
        if (data?.status !== "contacted") return null;
        return data;
      },
      { label: "canary lead moved to contacted", timeoutMs: 20_000 },
    );

    await page.reload();
    await page.getByRole("textbox", { name: /search leads/i }).fill(token);
    await expect(page.getByText(address).first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      page
        .locator("div")
        .filter({ has: page.getByText("Contacted", { exact: true }) })
        .filter({ has: page.getByText(address) })
        .first(),
    ).toBeVisible();
  } finally {
    await deleteCanaryPropertiesByAddress(supabase, address);
  }
});
