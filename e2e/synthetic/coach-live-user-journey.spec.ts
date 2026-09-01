import { expect, test, type Page } from "@playwright/test";
import tailwindcss from "@tailwindcss/postcss";
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import postcss from "postcss";

type Section = { id: string; phase_id: string; title: string };
type ContextStartupMode = "immediate" | "deferred" | "failure";

const spokenForkInventory: Record<string, string[]> = {
  "introduction.opener": [
    "Use default spoken fork for Opener",
    "Use Cold call spoken fork for Opener",
    "Use FSBO spoken fork for Opener",
    "Use SMS reply spoken fork for Opener",
    "Use Driving for dollars spoken fork for Opener",
  ],
  "reveal.situation-rundown": [
    "Use unknown spoken fork for Entry",
    "Use Owner-occupied spoken fork for Entry",
    "Use Tenant-occupied spoken fork for Entry",
    "Use Vacant spoken fork for Entry",
  ],
  "reveal.probe-options": [
    "Use Homeowner spoken fork for Example probes — goal 7+",
    "Use Investor spoken fork for Example probes — goal 7+",
    "Use Vacant spoken fork for Example probes — goal 7+",
  ],
  "reveal.motivation": [
    "Use Clear motivation, no urgency spoken fork for Motivation",
    "Use Clear motivation with urgency spoken fork for Motivation",
    "Use No clear motivation spoken fork for Motivation",
  ],
};

const sectionPathInventory: Record<string, { name: string; spokenText: string }[]> = {
  "offer.outcome-tracks": [
    { name: "Use Good news spoken path for Present the appropriate offer outcome", spokenText: "CONGRATS" },
    { name: "Use Bad news spoken path for Present the appropriate offer outcome", spokenText: "right around where I was thinking" },
    { name: "Use Bad news — below mortgage spoken path for Present the appropriate offer outcome", spokenText: "not able to get you approved" },
    { name: "Use Price too low spoken path for Present the appropriate offer outcome", spokenText: "our offer was lower" },
  ],
  "close.decision-tracks": [
    { name: "Use If far apart — program pivot spoken path for Choose the closing path", spokenText: "There is one program I can check" },
    { name: "Use They accept spoken path for Choose the closing path", spokenText: "Congratulations" },
  ],
};

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
  const bundleResult = await esbuild.build({
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
    plugins: [
      {
        name: "synthetic-coach-browser-boundaries",
        setup(build) {
          build.onResolve({ filter: /coach-context-actions$/ }, () => ({
            path: path.resolve(
              process.cwd(),
              "e2e/synthetic/fixtures/coach-context-actions-browser-stub.ts",
            ),
          }));
          build.onResolve({ filter: /supabase\/client$/ }, () => ({
            path: path.resolve(
              process.cwd(),
              "e2e/synthetic/fixtures/coach-supabase-browser-stub.ts",
            ),
          }));
        },
      },
    ],
    define: { "process.env.NODE_ENV": '"test"' },
    write: false,
    logLevel: "silent",
  });
  harnessBundle = bundleResult.outputFiles[0].text;
});

async function mountCoach(
  page: Page,
  viewport = { width: 1440, height: 900 },
  contextStartupMode: ContextStartupMode = "immediate",
): Promise<void> {
  await page.setViewportSize(viewport);
  await page.setContent(`<style>${compiledCss}</style><div id="root"></div>`);
  await page.evaluate((mode) => {
    window.coachContextStartupMode = mode;
  }, contextStartupMode);
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
  const fileNumber = page.getByTestId("coach-file-number");
  await expect(fileNumber).toHaveText("File number: JH-c1c524");
  await expect(page.getByTestId("current-phase-purpose")).toContainText("Build Minor Rapport");

  for (let index = 0; index < sections.length - 1; index += 1) {
    await expect(fileNumber).toHaveText("File number: JH-c1c524");
    await expect(page.getByTestId("next-section-preview")).toContainText(sections[index + 1].title);
    await page.getByTestId("coach-next").click();
    await expect(page.getByTestId("current-section-title")).toHaveText(sections[index + 1].title);
  }
  await expect(fileNumber).toHaveText("File number: JH-c1c524");
  await expect(page.getByTestId("coach-next")).toBeDisabled();
  await expect(page.getByTestId("next-section-preview")).toHaveCount(0);

  for (let index = sections.length - 1; index > 0; index -= 1) {
    await page.getByTestId("coach-back").click();
    await expect(page.getByTestId("current-section-title")).toHaveText(sections[index - 1].title);
  }
  await expect(page.getByTestId("coach-back")).toBeDisabled();
});

test("selects every approved spoken fork and path without changing navigation or call controls", async ({ page }) => {
  await mountCoach(page);

  for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex += 1) {
    const title = sections[sectionIndex].title;
    const card = page.getByTestId("current-script-card");
    const script = page.getByTestId("current-section-script");
    const choices = card.getByRole("tab");
    const choiceCount = await choices.count();
    const expectedForks = spokenForkInventory[sections[sectionIndex].id] ?? [];
    const expectedPaths = sectionPathInventory[sections[sectionIndex].id] ?? [];
    const phaseLabel = await page.getByTestId("coach-current-phase").textContent();
    const timerLabel = await page.getByTestId("coach-call-timer").textContent();

    expect(choiceCount).toBe(expectedForks.length + expectedPaths.length);

    for (let choiceIndex = 0; choiceIndex < choiceCount; choiceIndex += 1) {
      const choice = choices.nth(choiceIndex);
      const path = expectedPaths[choiceIndex - expectedForks.length];
      await expect(choice).toHaveAccessibleName(expectedForks[choiceIndex] ?? path.name);
      await choice.click();
      await expect(choice).toHaveAttribute("aria-selected", "true");
      await expect(page.getByTestId("current-section-title")).toHaveText(title);
      await expect(page.getByTestId("coach-current-phase")).toHaveText(phaseLabel ?? "");
      await expect(page.getByTestId("coach-call-timer")).toHaveText(timerLabel ?? "");
      await expect(page.getByTestId("coach-mute")).toHaveAttribute("aria-pressed", "false");
      await expect(page.getByTestId("coach-hold")).toHaveAttribute("aria-pressed", "false");
      await expect(script).not.toBeEmpty();
      if (path) {
        await expect(script.getByTestId("script-branch")).toHaveCount(1);
        await expect(script).toContainText(path.spokenText);
      }
    }

    if (sectionIndex < sections.length - 1) await page.getByTestId("coach-next").click();
  }
});

test("preserves the official document's multiline outcomes and e-sign steps", async ({ page }) => {
  await mountCoach(page);

  for (let step = 0; step < 3; step += 1) await page.getByTestId("coach-next").click();
  const outcomes = page.getByTestId("current-section-script").locator("p").filter({ hasText: "only 1 of 2 things" });
  await expect(outcomes).toHaveCSS("white-space", "pre-line");
  expect(await outcomes.innerText()).toContain("\n1. We can’t get you approved");
  expect(await outcomes.innerText()).toContain("\n2. We’ll get you approved");

  await page.getByTestId("phase-rail-close").click();
  await page.getByTestId("coach-next").click();
  await page.getByTestId("coach-next").click();
  const esign = page.getByTestId("current-section-script").locator("p").filter({ hasText: "Press view documents" });
  await expect(esign).toHaveCSS("white-space", "pre-line");
  expect(await esign.innerText()).toContain("\n\nPress view documents");
});

test("jumps each phase to its first manual section and legacy events are navigation/rendering no-ops", async ({ page }) => {
  await mountCoach(page);
  const phaseFirstTitles = new Map<string, string>();
  for (const section of sections) if (!phaseFirstTitles.has(section.phase_id)) phaseFirstTitles.set(section.phase_id, section.title);
  const phasePurposes = new Map<string, string>([
    ["introduction", "Build Minor Rapport - Break The Cycle of Traditional Sales Calls - Set Proper Expectations - Instill Scarcity… Can they qualify?"],
    ["reveal", "Make them FEEL their pain"],
    ["assessment", "Avoid “How Can You Buy My House Over The Phone?” Objection. Makes them feel like you are the real deal."],
    ["secure_positioning", "Avoid all smokescreens and objections after the offer by prehandling them upfront, and get the seller to confirm they want to move forward with our process before we present price."],
    ["offer", "Make the seller feel like they’ve qualified for our program — reinforcing that they need us, not the other way around. Step 1 is complete, and now it’s only about finalizing the minor details."],
    ["close", "Price is only an objection in the absence of value… how does our offer solve their problem?"],
  ]);

  for (const [phaseId, title] of phaseFirstTitles) {
    await page.getByTestId(`phase-rail-${phaseId}`).click();
    await expect(page.getByTestId("current-section-title")).toHaveText(title);
    await expect(page.getByTestId("current-phase-purpose")).toHaveText(`Purpose: ${phasePurposes.get(phaseId)}`);
  }

  await page.getByTestId("phase-rail-reveal").click();
  const before = await page.getByTestId("current-section-title").textContent();
  await emitStimulus(page, "legacyBatch");
  await expect(page.getByTestId("current-section-title")).toHaveText(before ?? "");
  await expect(page.getByText("Legacy note must remain invisible.")).toHaveCount(0);
  await expect(page.getByTestId("coach-transcript")).toContainText("Legacy-version transcript remains visible.");
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
  await expect(script).toContainText("responded to our teams text");

  for (let step = 0; step < 5; step += 1) await page.getByTestId("coach-next").click();
  await expect(page.getByTestId("current-section-title")).toHaveText("Exchange contact and file details");
  await expect(script).toContainText("My name is Jarrad Henry");
  await expect(script).toContainText("Our Company Name is BMH Group");
  await expect(script).toContainText("bmhgroupkc.com");
  await expect(script).toContainText("+18165550123");
  await expect(script).toContainText("JH-c1c524");

  await page.getByTestId("phase-rail-reveal").click();
  await page.getByTestId("variant-Entry-tenant_occupied").click();
  await expect(script).toContainText("you have these tenants");
  await page.getByTestId("variant-Entry-vacant").click();
  await expect(script).toContainText("its been vacant");

  await page.getByTestId("phase-rail-assessment").click();
  await page.getByTestId("coach-next").click();
  await expect(script).toContainText("1987’s");

  await page.getByTestId("phase-rail-offer").click();
  await expect(script).toContainText("move closer to family");
  for (const [field, value] of [
    ["dream_outcome", "retire near family"],
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

test("real session hook paints prepared homeowner and address during loading, then trusted context wins", async ({ page }) => {
  await mountCoach(page, { width: 1440, height: 900 }, "deferred");
  const script = page.getByTestId("current-section-script");

  await expect(page.getByTestId("current-script-card")).toBeVisible();
  await page.getByTestId("variant-Opener-cold_call").click();
  await expect(script).toContainText("Prepared");
  await expect(script).toContainText("55 Oak Avenue");
  await expect(page.getByTestId("coach-context-error")).toHaveCount(0);

  await emitStimulus(page, "resolveContext");
  await expect(script).toContainText("Jane");
  await expect(script).toContainText("123 Main Street");
  await expect(script).not.toContainText("Prepared");
  await expect(script).not.toContainText("55 Oak Avenue");
});

test("real session hook preserves prepared homeowner and address after context failure and retry", async ({ page }) => {
  await mountCoach(page, { width: 1440, height: 900 }, "failure");
  const script = page.getByTestId("current-section-script");

  await expect(page.getByTestId("coach-context-error")).toBeVisible();
  await page.getByTestId("variant-Opener-cold_call").click();
  await expect(script).toContainText("Prepared");
  await expect(script).toContainText("55 Oak Avenue");
  await expect(page.getByTestId("current-script-card")).toBeVisible();

  await emitStimulus(page, "contextImmediate");
  await page.getByTestId("coach-context-retry").click();
  await expect(page.getByTestId("coach-context-error")).toHaveCount(0);
  await expect(script).toContainText("Jane");
  await expect(script).toContainText("123 Main Street");
});

test("real session hook replaces the prior call with the next prepared target on first paint", async ({ page }) => {
  await mountCoach(page);
  const script = page.getByTestId("current-section-script");
  await expect(script).toContainText("Jane");

  await emitStimulus(page, "contextDeferred");
  await page.getByTestId("coach-collapse").click();
  await page.getByTestId("collapsed-new-call").click();

  await expect(page.getByTestId("synthetic-active-call")).toHaveText("synthetic-call-2");
  await page.getByTestId("variant-Opener-cold_call").click();
  await expect(script).toContainText("Hey Second?");
  await expect(script).toContainText("88 Pine Road");
  await expect(script).not.toContainText("Jane");
  await expect(script).not.toContainText("123 Main Street");
});

test("emulated finalized transcript never requests follow-ups until the rep clicks", async ({ page }) => {
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
  await page.waitForTimeout(1_650);
  await expect(page.getByTestId("synthetic-request-total")).toHaveText("Requests: 0");
  await expect(page.getByTestId("follow-up-questions")).toBeEnabled();
  await page.getByTestId("follow-up-questions").click();
  await expect(page.getByTestId("synthetic-request-total")).toHaveText("Requests: 1", { timeout: 3_000 });
  await expect(page.getByTestId("follow-up-question-options").getByRole("listitem")).toHaveCount(3);
  await expect(page.getByTestId("synthetic-request-total")).toHaveText("Requests: 1");
});

test("Objection Help classifies through the same authenticated boundary as follow-up, with a truthful no-match state", async ({ page }) => {
  // The harness's objection-help stub simulates the server-side classifier
  // deterministically for exactly the two known stimuli below — it proves
  // the click -> request -> loading -> render wiring end to end, not real
  // classification accuracy (that lives in recommendation-server.test.ts's
  // mocked-boundary unit tests against the actual prompt/parsing contract).
  await mountCoach(page);
  await expect(page.getByTestId("objection-help")).toBeDisabled();

  await emitStimulus(page, "sellerObjection");
  await expect(page.getByTestId("objection-help")).toBeEnabled();
  await expect(page.getByTestId("synthetic-request-total")).toHaveText("Requests: 0");
  await page.getByTestId("objection-help").click();

  // Objection Help now goes through the same request boundary as
  // follow-up, so it shows the same busy state and increments the same
  // request counter — it is no longer a synchronous local lookup.
  await expect(page.getByTestId("objection-help")).toBeDisabled();
  await expect(page.getByTestId("follow-up-questions")).toBeDisabled();

  await expect(page.getByTestId("objection-help-label")).toHaveText("Dont Trust", { timeout: 3_000 });
  await expect(page.getByTestId("synthetic-request-total")).toHaveText("Requests: 1");
  await expect(page.getByTestId("objection-help-acknowledge")).toContainText("completely right");
  await expect(page.getByTestId("objection-help-disarm")).toContainText("don't know enough about us");
  await expect(page.getByTestId("objection-help-overcome")).toContainText("feel more confident");
  await expect(page.getByTestId("current-section-title")).toHaveText(sections[0].title);
  await expect(page.getByTestId("objection-help")).toBeEnabled();
  await expect(page.getByTestId("follow-up-questions")).toBeEnabled();

  await emitStimulus(page, "newCall");
  await expect(page.getByTestId("synthetic-active-call")).toHaveText("synthetic-call-2");
  await emitStimulus(page, "sellerNoObjection");
  await page.getByTestId("objection-help").click();
  await expect(page.getByTestId("objection-help-no-match")).toContainText("No clear objection", { timeout: 3_000 });
  await expect(page.getByTestId("objection-help-result")).toHaveCount(0);
  await expect(page.getByTestId("synthetic-request-total")).toHaveText("Requests: 1");
});

test("follow-up clicks reject duplicates and keep exactly three grounded questions", async ({ page }) => {
  await mountCoach(page);
  await emitStimulus(page, "providerDeferred");
  await emitStimulus(page, "sellerMeaningful");
  await expect(page.getByTestId("synthetic-request-total")).toHaveText("Requests: 0");
  await expect(page.getByTestId("follow-up-questions")).toBeEnabled();
  await page.getByTestId("follow-up-questions").click();
  await expect(page.getByTestId("follow-up-questions")).toBeDisabled();
  await expect(page.getByTestId("follow-up-questions")).toHaveText(/Preparing follow-up questions/);
  await expect(page.getByTestId("follow-up-questions")).toHaveAttribute("aria-busy", "true");
  await expect(page.getByTestId("synthetic-request-total")).toHaveText("Requests: 1");
  await page.waitForTimeout(100);
  await expect(page.getByTestId("synthetic-request-total")).toHaveText("Requests: 1");

  await emitStimulus(page, "resolveDelayed");
  const questions = page.getByTestId("follow-up-question-options").getByRole("listitem");
  await expect(questions).toHaveCount(3);
  const text = await questions.allTextContents();
  expect(new Set(text).size).toBe(3);
  // Grounded in the actual seller statement just emitted ("We need to sell
  // before October because the carrying costs are becoming painful."), not
  // in unrelated canned text.
  expect(text.join(" ")).toContain("October");
  expect(text.join(" ")).toContain("carrying costs");
  await page.getByTestId("follow-up-questions").click();
  await expect(page.getByTestId("follow-up-questions")).toBeDisabled();
  await expect(page.getByTestId("synthetic-request-total")).toHaveText("Requests: 2");
  await emitStimulus(page, "resolveDelayed");
  await expect(questions).toHaveText(text);
});

test("late section and call responses cannot overwrite newer visible questions", async ({ page }) => {
  await mountCoach(page);
  await emitStimulus(page, "providerDeferred");
  await emitStimulus(page, "sellerMeaningful"); // "...before October because the carrying costs..."
  await expect(page.getByTestId("synthetic-request-total")).toHaveText("Requests: 0");
  await page.getByTestId("follow-up-questions").click();
  await expect(page.getByTestId("synthetic-request-total")).toHaveText("Requests: 1");
  await expect(page.getByTestId("coach-next")).toBeEnabled();
  await page.getByTestId("coach-next").click();
  // A rep turn breaks transcript grouping so the next seller line stays its
  // own entry instead of merging into the October statement above — the
  // harness grounds each response in only the newest seller line.
  await emitStimulus(page, "repFinal");
  await emitStimulus(page, "sellerSecondMeaningful"); // "My job is moving and I cannot afford two homes..."
  await page.getByTestId("follow-up-questions").click();
  await expect(page.getByTestId("synthetic-request-total")).toHaveText("Requests: 2");

  // Each response is grounded in the seller statement finalized at the time
  // of its own request, so the old (October) and new (job-moving) responses
  // are distinguishable — an overwrite by the stale one would be visible.
  await emitStimulus(page, "resolveNewestDelayed");
  const questions = page.getByTestId("follow-up-question-options").getByRole("listitem");
  await expect(questions).toHaveCount(3);
  const currentSectionQuestions = await questions.allTextContents();
  expect(currentSectionQuestions.join(" ")).toContain("job is moving");
  expect(currentSectionQuestions.join(" ")).not.toContain("October");

  await emitStimulus(page, "resolveDelayed"); // the stale, October-grounded response arrives late
  await expect(questions).toHaveText(currentSectionQuestions);
  expect((await questions.allTextContents()).join(" ")).not.toContain("October");

  await emitStimulus(page, "newCall");
  await expect(page.getByTestId("synthetic-active-call")).toHaveText("synthetic-call-2");
  await expect(page.getByTestId("current-section-title")).toHaveText(sections[0].title);
  await expect(page.getByTestId("follow-up-question-options")).toHaveCount(0);
});

test("a response that arrives after the call changes never renders into the new call", async ({ page }) => {
  await mountCoach(page);
  await emitStimulus(page, "providerDeferred");
  await emitStimulus(page, "sellerMeaningful"); // "...before October because the carrying costs..."
  await page.getByTestId("follow-up-questions").click();
  await expect(page.getByTestId("synthetic-request-total")).toHaveText("Requests: 1");

  // The request is still genuinely pending (providerDeferred never resolves
  // it) at the moment the call changes — unlike the section-change test
  // above, nothing has resolved this response yet.
  await emitStimulus(page, "newCall");
  await expect(page.getByTestId("synthetic-active-call")).toHaveText("synthetic-call-2");
  await expect(page.getByTestId("follow-up-question-options")).toHaveCount(0);

  // The stale, October-grounded response now resolves, after the call has
  // already moved on. It must never render into the new call.
  await emitStimulus(page, "resolveDelayed");
  await page.waitForTimeout(150);
  await expect(page.getByTestId("follow-up-question-options")).toHaveCount(0);
  await expect(page.getByText(/October/)).toHaveCount(0);
});

test("follow-up request cap is enforced through repeated user clicks without an extra provider call", async ({ page }) => {
  await mountCoach(page);
  await emitStimulus(page, "providerFast");
  await emitStimulus(page, "sellerFillerFinal");
  const followUp = page.getByTestId("follow-up-questions");
  await expect(followUp).toBeEnabled();

  for (let count = 1; count <= 20; count += 1) {
    await followUp.click();
    await expect(page.getByTestId("synthetic-request-total")).toHaveText(`Requests: ${count}`);
    await expect(followUp).toBeEnabled();
  }

  await followUp.click();
  await expect(page.getByTestId("synthetic-request-total")).toHaveText("Requests: 20");
  await expect(followUp).toBeDisabled();
  await expect(page.getByTestId("recommendation-error")).toContainText("limit for this call has been reached");
  await expect(page.getByTestId("follow-up-question-options").getByRole("listitem")).toHaveCount(3);
});

test("provider failure preserves prior valid questions and never takes over script, transcript, or navigation", async ({ page }) => {
  await mountCoach(page);
  await emitStimulus(page, "sellerMeaningful");
  await page.getByTestId("follow-up-questions").click();
  await expect(page.getByTestId("follow-up-question-options")).toBeVisible();
  const questions = await page.getByTestId("follow-up-question-options").allTextContents();
  await emitStimulus(page, "providerFailure");
  // A rep turn breaks transcript grouping so the retry's grounding reflects
  // only this newer seller line instead of merging into the first statement.
  await emitStimulus(page, "repFinal");
  await emitStimulus(page, "sellerSecondMeaningful");
  await page.getByTestId("follow-up-questions").click();
  await expect(page.getByTestId("recommendation-error")).toContainText("temporarily unavailable", { timeout: 4_000 });
  await expect(page.getByTestId("follow-up-questions")).toHaveText("Retry Follow-up Questions");
  await expect(page.getByTestId("follow-up-question-options")).toHaveText(questions);
  await expect(page.getByTestId("current-script-card")).toBeVisible();
  await expect(page.getByTestId("coach-transcript")).toBeVisible();
  await expect(page.getByTestId("coach-next")).toBeEnabled();

  await emitStimulus(page, "providerImmediate");
  await page.getByTestId("follow-up-questions").click();
  // The retry succeeds against the now-expanded transcript (the second
  // meaningful seller turn fired while the provider was failing), so it is
  // grounded in that newer statement rather than repeating the original —
  // wait for that new content to actually land before reading it.
  const options = page.getByTestId("follow-up-question-options");
  await expect(options).not.toHaveText(questions);
  await expect(page.getByTestId("recommendation-error")).toHaveCount(0);
  const retriedQuestions = await options.allTextContents();
  expect(retriedQuestions.join(" ")).toContain("job is moving");
  expect(retriedQuestions.join(" ")).not.toContain("October");
});

test("collapse/reopen persists the live session while a new call completely resets it", async ({ page }) => {
  await mountCoach(page);
  await page.getByTestId("coach-next").click();
  await emitStimulus(page, "sellerMeaningful");
  await page.getByTestId("follow-up-questions").click();
  await expect(page.getByTestId("follow-up-question-options")).toBeVisible();
  await page.getByTestId("coach-collapse").click();
  await expect(page.getByText("Coach collapsed")).toBeVisible();
  await page.getByTestId("reopen-coach").click();
  await expect(page.getByTestId("current-section-title")).toHaveText(sections[1].title);
  await expect(page.getByTestId("follow-up-question-options")).toBeVisible();
  await expect(page.getByTestId("transcript-line")).toContainText("carrying costs");

  await page.getByTestId("coach-collapse").click();
  await page.getByTestId("collapsed-new-call").click();
  await expect(page.getByTestId("current-section-title")).toHaveText(sections[0].title);
  await expect(page.getByTestId("coach-back")).toBeDisabled();
  await expect(page.getByTestId("follow-up-question-options")).toHaveCount(0);
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
