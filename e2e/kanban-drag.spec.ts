import { test, expect } from "@playwright/test";

import { adminClient, resetTenantTables, seedProspects } from "./fixtures";

/**
 * Kanban drag-to-status smoke. dnd-kit requires pointer events (not the
 * simple mousedown/up pattern) and needs enough movement to clear the
 * PointerSensor's 4px activation constraint. Using page.mouse with
 * explicit steps avoids the flakiness of Playwright's built-in dragTo()
 * against dnd-kit.
 */
test("dragging a card from New Lead to Contacted persists status change", async ({
  page,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  const [prop] = await seedProspects(admin, 1, "Drag");
  // Seed as a qualified lead so it lands on the kanban directly.
  await admin
    .from("properties")
    .update({ status: "new_lead" })
    .eq("id", prop.id);

  await page.goto("/leads");
  // The address itself is an inner link that intentionally stops pointer
  // propagation so clicking it opens detail without starting a drag. Target
  // the draggable card group instead.
  const card = page.getByRole("group", { name: `Lead at ${prop.address}` });
  await expect(card).toBeVisible();

  // Find the Contacted column (droppable). dnd-kit's useDroppable receives
  // the status string as its id, and the column is the outer container
  // around the header text.
  const contactedColumn = page.locator('[data-status="contacted"]');
  await expect(contactedColumn).toBeVisible();

  const cardBox = await card.boundingBox();
  const targetBox = await contactedColumn.boundingBox();
  if (!cardBox || !targetBox) throw new Error("missing bounding box");

  // Manual pointer dance: hover the card, press, move (long enough to
  // clear PointerSensor's 4px activation constraint), release over the
  // target column.
  await page.mouse.move(
    cardBox.x + cardBox.width / 2,
    cardBox.y + cardBox.height / 2,
  );
  await page.mouse.down();
  // Two moves — the first triggers activation, the second arrives at
  // the target. `steps` makes the intermediate path explicit so dnd-kit's
  // collision detection sees it.
  await page.mouse.move(
    cardBox.x + cardBox.width / 2 + 20,
    cardBox.y + cardBox.height / 2 + 20,
    { steps: 5 },
  );
  await page.mouse.move(
    targetBox.x + targetBox.width / 2,
    targetBox.y + 80,
    { steps: 15 },
  );
  await page.mouse.up();

  // Server update → DB reflects the new status.
  await expect(async () => {
    const { data } = await admin
      .from("properties")
      .select("status")
      .eq("id", prop.id)
      .single();
    expect(data?.status).toBe("contacted");
  }).toPass({ timeout: 5_000 });

  // And it survives a refresh — proving the persisted status drives the
  // column rendering on the next render.
  await page.reload();
  await expect(
    contactedColumn.getByRole("group", {
      name: `Lead at ${prop.address}`,
    }),
  ).toBeVisible();
});
