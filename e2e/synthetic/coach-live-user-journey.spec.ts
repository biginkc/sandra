import { expect, test, type Page } from "@playwright/test";
import tailwindcss from "@tailwindcss/postcss";
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import postcss from "postcss";

type Section = { id: string; phase_id: string; title: string };

let compiledCss = "";
let harnessBundle = "";
let sections: Section[] = [];

test.beforeAll(async () => {
  sections = JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), "src/lib/coach/closr-sections-v1.json"), "utf8"),
  ).sections as Section[];
  const cssResult = await postcss([tailwindcss()]).process('@import "tailwindcss";', {
    from: path.resolve(process.cwd(), "src/app/globals.css"),
  });
  compiledCss = cssResult.css;
  const bundleResult = esbuild.buildSync({
    entryPoints: [path.resolve(process.cwd(), "e2e/synthetic/fixtures/coach-live-behavior-harness.tsx")],
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "chrome120",
    jsx: "automatic",
    jsxImportSource: "react",
    alias: {
      "@/lib/coach/recommendation-action": path.resolve(
        process.cwd(),
        "e2e/synthetic/fixtures/coach-recommendation-action-stub.ts",
      ),
      "@": path.resolve(process.cwd(), "src"),
    },
    define: { "process.env.NODE_ENV": '"test"' },
    write: false,
    logLevel: "silent",
  });
  harnessBundle = bundleResult.outputFiles[0].text;
});

async function mountCoach(page: Page, viewport = { width: 1440, height: 900 }): Promise<void> {
  await page.setViewportSize(viewport);
  await page.setContent(`<style>${compiledCss}</style><div id="root"></div>`);
  await page.addScriptTag({ content: harnessBundle });
  const coach = page.getByTestId("coach-live-view");
  await expect(coach).toBeVisible();
  await coach.evaluate(async (element) => {
    await Promise.allSettled(element.getAnimations().map((animation) => animation.finished));
  });
}

async function emitStimulus(page: Page, name: string): Promise<void> {
  await page.evaluate((stimulus) => window.coachBehaviorHarness[stimulus](), name);
}

test("walks every PDF-aligned section forward and backward with correct boundaries and previews", async ({ page }) => {
  await mountCoach(page);
  expect(sections).toHaveLength(26);
  await expect(page.getByTestId("coach-back")).toBeDisabled();
  await expect(page.getByTestId("current-section-title")).toHaveText(sections[0].title);

  for (let index = 0; index < sections.length - 1; index += 1) {
    await expect(page.getByTestId("next-section-preview")).toContainText(sections[index + 1].title);
    await page.getByTestId("coach-next").click();
    await expect(page.getByTestId("current-section-title")).toHaveText(sections[index + 1].title);
  }
  await expect(page.getByTestId("coach-next")).toBeDisabled();
  await expect(page.getByTestId("next-section-preview")).toHaveCount(0);

  for (let index = sections.length - 1; index > 0; index -= 1) {
    await page.getByTestId("coach-back").click();
    await expect(page.getByTestId("current-section-title")).toHaveText(sections[index - 1].title);
  }
  await expect(page.getByTestId("coach-back")).toBeDisabled();
});

test("jumps each phase to its first manual section and legacy events are navigation/rendering no-ops", async ({ page }) => {
  await mountCoach(page);
  const phaseFirstTitles = new Map<string, string>();
  for (const section of sections) if (!phaseFirstTitles.has(section.phase_id)) phaseFirstTitles.set(section.phase_id, section.title);

  for (const [phaseId, title] of phaseFirstTitles) {
    await page.getByTestId(`phase-rail-${phaseId}`).click();
    await expect(page.getByTestId("current-section-title")).toHaveText(title);
  }

  await page.getByTestId("phase-rail-reveal").click();
  const before = await page.getByTestId("current-section-title").textContent();
  await emitStimulus(page, "legacyBatch");
  await expect(page.getByTestId("current-section-title")).toHaveText(before ?? "");
  await expect(page.getByText("Legacy note must remain invisible.")).toHaveCount(0);
  await expect(page.getByTestId("current-script-card")).toBeVisible();
});

test("populates known lead tokens, selects lead and occupancy variants, and lets the rep enter deal values", async ({ page }) => {
  await mountCoach(page);
  const script = page.getByTestId("current-section-script");
  await expect(script).toContainText("Jane");
  await expect(script).toContainText("Jarrad Henry");
  await expect(script).toContainText("Taylor");
  await expect(script).toContainText("123 Main Street");
  await expect(script).toContainText("move closer to family");
  await expect(page.getByTestId("variant-Opener-cold_call")).toHaveAttribute("aria-selected", "true");

  await page.getByTestId("variant-Opener-fsbo").click();
  await expect(script).toContainText("For Sale by Owner");
  await page.getByTestId("variant-Opener-sms").click();
  await expect(script).toContainText("responded to our team's text");

  await page.getByTestId("phase-rail-reveal").click();
  await emitStimulus(page, "occupancyTenant");
  await expect(script).toContainText("you have these tenants");
  await emitStimulus(page, "occupancyVacant");
  await expect(script).toContainText("it's been vacant");

  await page.getByTestId("phase-rail-offer").click();
  for (const [field, value] of [
    ["offer_price", "$210,000"],
    ["net_to_seller", "$185,000"],
    ["closing_date", "October 18"],
  ] as const) {
    await page.getByTestId(`entry-chip-${field}`).first().click();
    await page.getByTestId(`entry-input-${field}`).fill(value);
    await page.getByTestId(`entry-input-${field}`).press("Enter");
    await expect(page.getByTestId("current-section-script")).toContainText(value);
  }
});

test("emulated audio triggers automatic advice only for meaningful finalized homeowner speech", async ({ page }) => {
  await mountCoach(page);
  await emitStimulus(page, "sellerInterim");
  await page.waitForTimeout(1_650);
  await expect(page.getByTestId("synthetic-request-total")).toHaveText("Requests: 0");
  await emitStimulus(page, "sellerFillerFinal");
  await page.waitForTimeout(1_650);
  await expect(page.getByTestId("synthetic-request-total")).toHaveText("Requests: 0");
  await emitStimulus(page, "repFinal");
  await page.waitForTimeout(1_650);
  await expect(page.getByTestId("synthetic-request-total")).toHaveText("Requests: 0");
  await emitStimulus(page, "sellerMeaningful");
  await expect(page.getByTestId("synthetic-request-total")).toHaveText("Requests: 1", { timeout: 3_000 });
  await expect(page.getByTestId("automatic-recommendations-loading")).toBeVisible();
  await expect(page.getByTestId("automatic-recommendations")).toContainText("moving closer to family");
  await expect(page.getByTestId("synthetic-request-total")).toHaveText("Requests: 1");
});

test("follow-up supersedes automatic work, rejects duplicates, and keeps exactly three grounded questions", async ({ page }) => {
  await mountCoach(page);
  await emitStimulus(page, "providerDeferred");
  await emitStimulus(page, "sellerMeaningful");
  await expect(page.getByTestId("automatic-recommendations-loading")).toBeVisible({ timeout: 3_000 });
  await expect(page.getByTestId("follow-up-questions")).toBeEnabled();
  await page.getByTestId("follow-up-questions").click();
  await expect(page.getByTestId("follow-up-questions")).toBeDisabled();
  await expect(page.getByTestId("synthetic-request-total")).toHaveText("Requests: 2");
  await page.waitForTimeout(100);
  await expect(page.getByTestId("synthetic-request-total")).toHaveText("Requests: 2");

  await emitStimulus(page, "resolveNewestDelayed");
  const questions = page.getByTestId("follow-up-question-options").getByRole("listitem");
  await expect(questions).toHaveCount(3);
  const text = await questions.allTextContents();
  expect(new Set(text).size).toBe(3);
  expect(text.join(" ")).toContain("family");
  await emitStimulus(page, "resolveDelayed");
  await expect(questions).toHaveText(text);
  await expect(page.getByTestId("synthetic-request-total")).toHaveText("Requests: 2");
});

test("stale section and call responses are rejected while loading never disables navigation", async ({ page }) => {
  await mountCoach(page);
  await emitStimulus(page, "providerDeferred");
  await emitStimulus(page, "sellerMeaningful");
  await expect(page.getByTestId("synthetic-request-total")).toHaveText("Requests: 1", { timeout: 3_000 });
  await expect(page.getByTestId("automatic-recommendations-loading")).toBeVisible();
  await expect(page.getByTestId("coach-next")).toBeEnabled();
  await page.getByTestId("coach-next").click();
  await emitStimulus(page, "resolveDelayed");
  await expect(page.getByTestId("automatic-recommendations")).toHaveCount(0);

  await emitStimulus(page, "sellerSecondMeaningful");
  await expect(page.getByTestId("synthetic-request-total")).toHaveText("Requests: 2", { timeout: 3_000 });
  await expect(page.getByTestId("automatic-recommendations-loading")).toBeVisible();
  await emitStimulus(page, "newCall");
  await expect(page.getByTestId("synthetic-active-call")).toHaveText("synthetic-call-2");
  await emitStimulus(page, "resolveDelayed");
  await expect(page.getByTestId("current-section-title")).toHaveText(sections[0].title);
  await expect(page.getByTestId("automatic-recommendations")).toHaveCount(0);
});

test("provider failure preserves prior valid advice and never takes over script, transcript, or navigation", async ({ page }) => {
  await mountCoach(page);
  await emitStimulus(page, "sellerMeaningful");
  await expect(page.getByTestId("automatic-recommendations")).toContainText("moving closer to family", { timeout: 4_000 });
  await emitStimulus(page, "providerFailure");
  await emitStimulus(page, "sellerSecondMeaningful");
  await expect(page.getByTestId("recommendation-error")).toContainText("temporarily unavailable", { timeout: 4_000 });
  await expect(page.getByTestId("automatic-recommendations")).toContainText("moving closer to family");
  await expect(page.getByTestId("current-script-card")).toBeVisible();
  await expect(page.getByTestId("coach-transcript")).toBeVisible();
  await expect(page.getByTestId("coach-next")).toBeEnabled();
});

test("collapse/reopen persists the live session while a new call completely resets it", async ({ page }) => {
  await mountCoach(page);
  await page.getByTestId("coach-next").click();
  await emitStimulus(page, "sellerMeaningful");
  await expect(page.getByTestId("automatic-recommendations")).toBeVisible({ timeout: 4_000 });
  await page.getByTestId("coach-collapse").click();
  await expect(page.getByText("Coach collapsed")).toBeVisible();
  await page.getByTestId("reopen-coach").click();
  await expect(page.getByTestId("current-section-title")).toHaveText(sections[1].title);
  await expect(page.getByTestId("automatic-recommendations")).toBeVisible();
  await expect(page.getByTestId("transcript-line")).toContainText("carrying costs");

  await page.getByTestId("coach-collapse").click();
  await page.getByTestId("collapsed-new-call").click();
  await expect(page.getByTestId("current-section-title")).toHaveText(sections[0].title);
  await expect(page.getByTestId("coach-back")).toBeDisabled();
  await expect(page.getByTestId("automatic-recommendations")).toHaveCount(0);
  await expect(page.getByTestId("transcript-line")).toHaveCount(0);
});

test("reconnect, degraded transcript, and context failure remain visible without covering the script", async ({ page }) => {
  await mountCoach(page);
  await emitStimulus(page, "reconnect");
  await emitStimulus(page, "degraded");
  await emitStimulus(page, "contextError");
  await expect(page.getByTestId("coach-reconnect-gap")).toBeVisible();
  await expect(page.getByTestId("coach-degraded-note")).toBeVisible();
  await expect(page.getByTestId("coach-context-error")).toBeVisible();
  await expect(page.getByTestId("current-script-card")).toBeVisible();
  await expect(page.getByTestId("coach-next")).toBeEnabled();
  await page.getByTestId("coach-context-retry").click();
  await expect(page.getByTestId("coach-context-error")).toHaveCount(0);
});

test("mute, hold, keypad, hangup, and desktop/mobile surface ordering work through user clicks", async ({ page }) => {
  await mountCoach(page);
  await page.getByTestId("coach-mute").click();
  await expect(page.getByTestId("coach-mute")).toHaveText("Unmute");
  await page.getByTestId("coach-hold").click();
  await expect(page.getByTestId("coach-hold")).toHaveText("Resume");
  await expect(page.getByTestId("coach-keypad-toggle")).toBeDisabled();
  await page.getByTestId("coach-hold").click();
  await page.getByTestId("coach-keypad-toggle").click();
  await page.getByRole("button", { name: "Keypad 6" }).click();
  await page.getByRole("button", { name: "Keypad #" }).click();
  await expect(page.getByTestId("synthetic-digits")).toHaveText("Digits: 6#");
  await page.getByTestId("coach-hangup").click();
  await expect(page.getByTestId("coach-live-pill")).toHaveCount(0);

  await mountCoach(page, { width: 375, height: 812 });
  const transcript = await page.getByLabel("Live transcript").boundingBox();
  const script = await page.getByTestId("coach-script-panel").boundingBox();
  const recommendations = await page.getByTestId("coach-recommendations").boundingBox();
  expect(transcript).not.toBeNull();
  expect(script).not.toBeNull();
  expect(recommendations).not.toBeNull();
  expect(transcript!.y + transcript!.height).toBeLessThanOrEqual(script!.y + 1);
  expect(script!.y + script!.height).toBeLessThanOrEqual(recommendations!.y + 1);
});
