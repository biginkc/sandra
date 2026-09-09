import { expect, test } from "@playwright/test";
import { buildSearchOverlayFixture } from "./fixtures/search-redesign/build";

// UI-only fixtures: no seed, migration, provider call, or search-semantics claims.
const results = ["property", "owner", "thread"].flatMap(type => Array.from({ length: 5 }, (_, i) => ({
  type, key: `${type}-${i}`, title: `${type} ${i + 1} — long production title for truncation`,
  subtitle: type === "thread" ? "A literal message preview with enough words to exercise ellipsis on mobile." : "Production secondary string preserved verbatim",
  matchedField: type === "owner" ? (i % 2 ? "email" : "phone") : "name",
  href: type === "property" ? `/leads/property-${i}` : `/messages?thread=${type}-${i}`,
})));

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 664 }]) {
  test(`§12/1,2,9,12,16 viewport ${viewport.width}×${viewport.height}: modal, groups, scroll and focus (iOS substitute only)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.route("**/api/search?*", route => route.fulfill({ json: { results } }));
    await page.goto("/dashboard");
    const trigger = page.getByRole("button", { name: "Search", exact: true });
    await expect(trigger).toBeVisible();
    const triggerBox = await trigger.boundingBox(); expect(triggerBox!.height).toBeGreaterThanOrEqual(44);
    await page.evaluate(() => { (document.querySelector("main") as HTMLElement).dataset.searchContinuity = "preserved"; });
    const before = await page.evaluate(() => window.scrollY);
    await trigger.click();
    const input = page.getByRole("combobox", { name: "Search", exact: true });
    await expect(input).toBeFocused(); await expect(input).toHaveValue("");
    await input.fill("query"); await expect(page.getByRole("option")).toHaveCount(15);
    await expect(page.getByRole("group", { name: "Owners", exact: true })).toBeVisible();
    await expect(page.getByRole("group", { name: "Messages", exact: true })).toBeVisible();
    const popup = page.getByRole("dialog", { name: "Search", exact: true });
    await expect(popup).toHaveCSS("position", "fixed"); await expect(popup).toHaveCSS("z-index", "100");
    const box = await popup.boundingBox(); expect(box!.width).toBe(viewport.width); expect(box!.height).toBe(viewport.height);
    const first = await page.getByRole("option").first().boundingBox(); expect(first!.y + first!.height).toBeLessThan(viewport.height * .4);
    await page.screenshot({ path: `tmp/search-redesign/search-${viewport.width}.png` });
    await input.press("End"); await expect(page.getByRole("option").last()).toHaveAttribute("aria-selected", "true"); await expect(page.getByRole("option").last()).toBeInViewport();
    expect(await page.evaluate(() => window.scrollY)).toBe(before);
    for (let i = 0; i < 6; i++) { await page.keyboard.press("Tab"); await expect.poll(() => popup.evaluate(element => element.contains(document.activeElement))).toBe(true); }
    for (let i = 0; i < 6; i++) { await page.keyboard.press("Shift+Tab"); await expect.poll(() => popup.evaluate(element => element.contains(document.activeElement))).toBe(true); }
    await page.keyboard.press("Escape"); await expect(popup).toHaveCount(0); await expect(trigger).toBeFocused();
    expect(await page.evaluate(() => window.scrollY)).toBe(before); await expect(page.locator("main")).toHaveAttribute("data-search-continuity", "preserved");
    await trigger.click(); await expect(input).toHaveValue(""); await expect(input).toBeFocused(); await page.keyboard.press("Escape");
    // Layout persists on the Messages page; its inbox search is not touched.
    await page.goto("/messages"); await expect(trigger).toBeVisible(); await page.keyboard.press("Control+k"); await expect(input).toBeFocused(); await page.keyboard.press("Control+k"); await expect(popup).toHaveCount(0);
  });
}

test("§12/13,14,15 real browser loading, retained results, recovery and client deadline", async ({ page }) => {
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await page.route("**/api/search?*", async route => {
    const query = new URL(route.request().url()).searchParams.get("q");
    if (query === "stalled") return; // Intentionally unanswered; no real request leaves the browser.
    await route.fulfill(query === "failed" ? { status: 500, json: {} } : { json: { results } });
  });
  await page.goto("/dashboard"); await page.getByRole("button", { name: "Search", exact: true }).click();
  const input = page.getByRole("combobox"); await input.fill("query"); await page.clock.runFor(200); await expect(page.getByRole("option")).toHaveCount(15);
  await input.fill("stalled"); await page.clock.runFor(200); await expect(page.getByRole("listbox")).toHaveCSS("opacity", "0.55"); await page.clock.runFor(14999); await expect(page.getByRole("alert").filter({ hasText: "Search unavailable" })).toHaveCount(0);
  await page.clock.runFor(1); await expect(page.getByRole("alert").filter({ hasText: "Search unavailable" })).toBeVisible(); await expect(page.getByRole("option")).toHaveCount(0);
  await input.fill("retry"); await page.clock.runFor(200); await expect(page.getByRole("option")).toHaveCount(15);
  await input.fill("failed"); await page.clock.runFor(200); await expect(page.getByRole("alert").filter({ hasText: "Search unavailable" })).toBeVisible();
});

for (const width of [1440, 390]) {
  test(`§12/1,12 overlay interaction ${width}: actual softphone toast and live fixture survive search`, async ({ page }) => {
    const html = await buildSearchOverlayFixture();
    await page.setViewportSize({ width, height: 664 });
    await page.route("**/__search_overlay_fixture", route => route.fulfill({ contentType: "text/html", body: html }));
    await page.route("**/api/search?*", route => route.fulfill({ json: { results } }));
    await page.goto("/__search_overlay_fixture");
    await page.getByTestId("call-lead-button").click(); await expect(page.getByTestId("call-live-pill")).toContainText("Live");
    await page.getByTestId("call-mute").click();
    const toast = page.getByRole("status").filter({ hasText: "Mute failed" }); await expect(toast).toBeVisible();
    await page.keyboard.press("Control+k"); const input = page.getByRole("combobox"); await input.fill("query"); await expect(page.getByRole("option")).toHaveCount(15);
    // Inspect the real toast DOM even if the modal marks its portal inert.
    const geometry = await page.locator('[role="status"]').filter({ hasText: "Mute failed" }).evaluate(toastElement => {
      const toastRect = toastElement.getBoundingClientRect();
      return [document.querySelector('input[role="combobox"]')!, document.querySelector('[role="option"]')!].map(element => {
        const rect = element.getBoundingClientRect();
        return { overlaps: rect.left < toastRect.right && rect.right > toastRect.left && rect.top < toastRect.bottom && rect.bottom > toastRect.top };
      });
    });
    expect(geometry.every(item => !item.overlaps)).toBe(true);
    await page.screenshot({ path: `tmp/search-redesign/softphone-${width}.png` });
    await page.keyboard.press("Escape"); await expect(page.getByTestId("call-live-pill")).toContainText("Live"); expect(await page.locator("body").getAttribute("data-fixture-hangups")).toBeNull();
  });
}

test("§12/1 closing nested search preserves outer modal lock and restores page scrolling afterward", async ({ page }) => {
  await page.route("**/__search_overlay_fixture", async route => route.fulfill({ contentType: "text/html", body: await buildSearchOverlayFixture() }));
  await page.goto("/__search_overlay_fixture");
  await page.getByRole("button", { name: "Open outer dialog" }).click();
  await page.keyboard.press("Control+k"); await expect(page.getByRole("combobox")).toBeFocused();
  await page.keyboard.press("Escape"); await expect(page.getByRole("combobox")).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Outer dialog" })).toBeVisible();
  const before = await page.evaluate(() => window.scrollY); await page.mouse.wheel(0, 500); expect(await page.evaluate(() => window.scrollY)).toBe(before);
  await page.getByRole("button", { name: "Close outer dialog" }).click(); await expect(page.getByRole("dialog")).toHaveCount(0); await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden"); await page.mouse.move(300, 400); await page.mouse.wheel(0, 500); await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(before);
});
