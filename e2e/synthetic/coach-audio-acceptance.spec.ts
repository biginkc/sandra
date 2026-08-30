import { expect, test, type Page } from "@playwright/test";
import tailwindcss from "@tailwindcss/postcss";
import * as esbuild from "esbuild";
import path from "node:path";
import postcss from "postcss";

type AudioStimulus = "readyNoAttach" | "frozenRtp" | "advancingRtp" | "providerTerminalConfirmed";
type BrowserErrorEvidence = { consoleErrors: string[]; pageErrors: string[] };

let compiledCss = "";
let harnessBundle = "";

test.beforeAll(async () => {
  const cssResult = await postcss([tailwindcss()]).process('@import "tailwindcss";', {
    from: path.resolve(process.cwd(), "src/app/globals.css"),
  });
  compiledCss = cssResult.css;
  const bundleResult = await esbuild.build({
    entryPoints: [path.resolve(process.cwd(), "e2e/synthetic/fixtures/coach-audio-acceptance-harness.tsx")],
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "chrome120",
    jsx: "automatic",
    jsxImportSource: "react",
    alias: {
      "@/lib/coach/recommendation-action": path.resolve(process.cwd(), "e2e/synthetic/fixtures/coach-recommendation-action-stub.ts"),
      "@": path.resolve(process.cwd(), "src"),
    },
    plugins: [{
      name: "synthetic-coach-browser-boundaries",
      setup(build) {
        build.onResolve({ filter: /coach-context-actions$/ }, () => ({
          path: path.resolve(process.cwd(), "e2e/synthetic/fixtures/coach-context-actions-browser-stub.ts"),
        }));
        build.onResolve({ filter: /supabase\/client$/ }, () => ({
          path: path.resolve(process.cwd(), "e2e/synthetic/fixtures/coach-supabase-browser-stub.ts"),
        }));
        build.onResolve({ filter: /dialer\/jitter-actions$|\.\/jitter-actions$/ }, () => ({
          path: path.resolve(process.cwd(), "e2e/synthetic/fixtures/jitter-actions-browser-stub.ts"),
        }));
        build.onResolve({ filter: /^@telnyx\/webrtc$/ }, () => ({
          path: path.resolve(process.cwd(), "e2e/synthetic/fixtures/telnyx-webrtc-browser-stub.ts"),
        }));
      },
    }],
    define: { "process.env.NODE_ENV": '"test"' },
    write: false,
    logLevel: "silent",
  });
  harnessBundle = bundleResult.outputFiles[0].text;
});

async function mountCoach(page: Page): Promise<BrowserErrorEvidence> {
  const evidence: BrowserErrorEvidence = { consoleErrors: [], pageErrors: [] };
  page.on("console", (message) => {
    if (message.type() === "error") evidence.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => evidence.pageErrors.push(error.stack ?? error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.setContent(`<style>${compiledCss}</style><div id="root"></div>`);
  await page.addScriptTag({ content: harnessBundle });
  await expect(page.getByTestId("coach-live-view")).toBeVisible();
  await expect(page.getByTestId("transport-state-history")).toContainText("connecting|ringing|live");
  await expect(page.getByTestId("transport-ready")).toHaveText("ready");
  return evidence;
}

function expectNoBrowserErrors(evidence: BrowserErrorEvidence): void {
  expect(
    evidence,
    `Unexpected browser errors:\n${JSON.stringify(evidence, null, 2)}`,
  ).toEqual({ consoleErrors: [], pageErrors: [] });
}

async function stimulate(page: Page, stimulus: AudioStimulus): Promise<void> {
  await page.evaluate((name) => window.coachAudioAcceptanceHarness[name](), stimulus);
}

async function expectGuidancePreserved(page: Page): Promise<void> {
  await expect(page.getByTestId("current-section-script")).toBeVisible();
  await expect(page.getByTestId("coach-transcript")).toContainText("This synthetic conversation contains no personal information.");
}

test("ready without media attachment stays nonterminal and does not claim restored audio", async ({ page }, testInfo) => {
  const browserErrors = await mountCoach(page);
  await stimulate(page, "readyNoAttach");

  await expect(page.getByTestId("coach-audio-reconnect-warning")).toContainText("reconnecting browser audio");
  await expect(page.getByTestId("coach-reconnect-audio")).toBeDisabled();
  await expect(page.getByTestId("coach-warning-hangup")).toHaveText("Hang Up");
  await expect(page.getByTestId("transport-state-history")).toContainText("audio_reconnect_required|audio_reconnecting");
  await expect(page.getByTestId("cancel-request-count")).toHaveText("0");
  await expect(page.getByTestId("sdk-hangup-count")).toHaveText("0");
  await expect(page.getByTestId("manual-hangup-count")).toHaveText("0");
  await expect(page.getByTestId("provider-status-request-count")).toHaveText("0");
  await expectGuidancePreserved(page);
  await page.screenshot({ path: testInfo.outputPath("ready-no-attach.png"), fullPage: true });
  expectNoBrowserErrors(browserErrors);
});

test("frozen RTP status proof remains nonterminal with recovery and hangup available", async ({ page }, testInfo) => {
  const browserErrors = await mountCoach(page);
  await stimulate(page, "frozenRtp");
  await expect(page.getByTestId("coach-audio-reconnect-warning")).toContainText("audio interrupted");
  await expect(page.getByTestId("health-report-count")).not.toHaveText("0");
  await expect(page.getByTestId("last-health-packets")).toHaveText("10");
  await expect(page.getByTestId("coach-reconnect-audio")).toBeEnabled();
  await expect(page.getByTestId("coach-warning-hangup")).toBeEnabled();
  await expect(page.getByTestId("cancel-request-count")).toHaveText("0");
  await expect(page.getByTestId("sdk-hangup-count")).toHaveText("0");
  await expect(page.getByTestId("manual-hangup-count")).toHaveText("0");
  await expect(page.getByTestId("provider-status-request-count")).toHaveText("0");
  await expectGuidancePreserved(page);
  await page.screenshot({ path: testInfo.outputPath("frozen-rtp.png"), fullPage: true });
  expectNoBrowserErrors(browserErrors);
});

test("advancing inbound RTP plus audible playout restores live audio", async ({ page }, testInfo) => {
  const browserErrors = await mountCoach(page);
  const initialPlayCount = Number(await page.getByTestId("remote-audio-play-count").textContent());
  await stimulate(page, "advancingRtp");
  await expect(page.getByTestId("coach-audio-reconnect-warning")).toHaveCount(0);
  await expect(page.getByTestId("coach-live-view")).toBeVisible();
  await expect(page.getByTestId("transport-state-history")).toContainText("audio_reconnecting|live");
  await expect.poll(async () => Number(await page.getByTestId("remote-audio-play-count").textContent())).toBeGreaterThan(initialPlayCount);
  await expect(page.getByTestId("cancel-request-count")).toHaveText("0");
  await expect(page.getByTestId("sdk-hangup-count")).toHaveText("0");
  await expect(page.getByTestId("manual-hangup-count")).toHaveText("0");
  await expect(page.getByTestId("provider-status-request-count")).toHaveText("0");
  await expectGuidancePreserved(page);
  await page.screenshot({ path: testInfo.outputPath("advancing-rtp-restored.png"), fullPage: true });
  expectNoBrowserErrors(browserErrors);
});

test("confirmed provider terminal is distinct from explicit manual hangup", async ({ page }, testInfo) => {
  const browserErrors = await mountCoach(page);
  await stimulate(page, "providerTerminalConfirmed");

  await expect(page.getByTestId("coach-live-view")).toHaveCount(0);
  await expect(page.getByTestId("coach-terminal")).toContainText("provider status endpoint confirmed the homeowner ended the call");
  await expect(page.getByTestId("provider-status-request-count")).toHaveText("1");
  await expect(page.getByTestId("manual-hangup-count")).toHaveText("0");
  await expect(page.getByTestId("cancel-request-count")).toHaveText("0");
  await expect(page.getByTestId("sdk-hangup-count")).toHaveText("0");
  await page.screenshot({ path: testInfo.outputPath("provider-terminal-confirmed.png"), fullPage: true });
  expectNoBrowserErrors(browserErrors);
});

test("Hang Up uses the explicit user teardown path and never provider proof", async ({ page }, testInfo) => {
  const browserErrors = await mountCoach(page);
  await page.getByTestId("coach-hangup").click();

  await expect(page.getByTestId("coach-live-view")).toHaveCount(0);
  await expect(page.getByTestId("manual-hangup-count")).toHaveText("1");
  await expect(page.getByTestId("cancel-request-count")).toHaveText("1");
  await expect(page.getByTestId("provider-status-request-count")).toHaveText("0");
  await expect(page.getByTestId("sdk-hangup-count")).toHaveText("1");
  await expect(page.getByTestId("coach-terminal")).toContainText("The rep ended the call with Hang Up.");
  await expect(page.getByTestId("coach-terminal")).not.toContainText("provider status endpoint confirmed");
  await page.screenshot({ path: testInfo.outputPath("manual-hangup.png"), fullPage: true });
  expectNoBrowserErrors(browserErrors);
});
