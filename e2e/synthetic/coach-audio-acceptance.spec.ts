import { expect, test, type Page } from "@playwright/test";
import tailwindcss from "@tailwindcss/postcss";
import * as esbuild from "esbuild";
import { readFile } from "node:fs/promises";
import path from "node:path";
import postcss from "postcss";

type AudioStimulus = "readyNoAttach" | "frozenRtp" | "advancingRtp" | "providerTerminalConfirmed" | "loseHoldAck" | "confirmHealth" | "heldReconnect" | "holdReapplyFailure" | "rejectMute" | "rejectUnmute" | "rejectHold" | "rejectResume" | "providerHeldUpdate" | "providerActiveUpdate";
type BrowserErrorEvidence = { consoleErrors: string[]; pageErrors: string[] };

let compiledCss = "";
let harnessBundle = "";

test.beforeAll(async () => {
  const globalsPath = path.resolve(process.cwd(), "src/app/globals.css");
  const globalsSource = await readFile(globalsPath, "utf8");
  const cssResult = await postcss([tailwindcss()]).process(globalsSource, { from: globalsPath });
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
        build.onResolve({ filter: /dialer\/actions$/ }, () => ({
          path: path.resolve(process.cwd(), "e2e/synthetic/fixtures/dialer-actions-browser-stub.ts"),
        }));
        build.onResolve({ filter: /^@telnyx\/webrtc$/ }, () => ({
          path: path.resolve(process.cwd(), "e2e/synthetic/fixtures/telnyx-webrtc-browser-stub.ts"),
        }));
      },
    }],
    define: {
      "process.env.NODE_ENV": '"test"',
      "process.env.NEXT_PUBLIC_SOFTPHONE_TRANSPORT": '"jitter"',
      "process.env.NEXT_PUBLIC_COACH_UI_ENABLED": '"1"',
    },
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
  await page.route("http://synthetic.local/**", (route) => route.fulfill({
    status: 200,
    contentType: "text/html",
    body: `<style>${compiledCss}</style><div id="root"></div>`,
  }));
  await page.goto("http://synthetic.local/");
  await page.addScriptTag({ content: harnessBundle });
  await page.waitForTimeout(100);
  if (await page.getByTestId("coach-live-view").count() === 0) {
    throw new Error(`Provider harness did not mount Coach: ${JSON.stringify(evidence)} body=${(await page.locator("body").innerText()).slice(0, 500)}`);
  }
  await expect(page.getByTestId("coach-live-view")).toBeVisible();
  await expect(page.getByTestId("transport-state-history")).toContainText("audio_reconnect_required|live");
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

type GuidanceSnapshot = { title: string; script: string; transcript: string };

async function captureNonInitialGuidance(page: Page): Promise<GuidanceSnapshot> {
  await expect(page.getByTestId("coach-transcript")).toContainText(
    "This synthetic conversation contains no personal information.",
  );
  await page.getByTestId("coach-next").click();
  await expect(page.getByTestId("current-section-title")).not.toHaveText("Open the call");
  return {
    title: (await page.getByTestId("current-section-title").textContent() ?? ""),
    script: (await page.getByTestId("current-section-script").textContent() ?? ""),
    transcript: (await page.getByTestId("coach-transcript").textContent() ?? ""),
  };
}

async function expectGuidancePreserved(page: Page, expected: GuidanceSnapshot): Promise<void> {
  await expect.poll(() => page.getByTestId("current-section-title").textContent()).toBe(expected.title);
  await expect.poll(() => page.getByTestId("current-section-script").textContent()).toBe(expected.script);
  await expect.poll(() => page.getByTestId("coach-transcript").textContent()).toBe(expected.transcript);
}

test("ready without media attachment stays nonterminal and does not claim restored audio", async ({ page }, testInfo) => {
  const browserErrors = await mountCoach(page);
  const guidance = await captureNonInitialGuidance(page);
  await stimulate(page, "readyNoAttach");
  await expect(page.getByTestId("coach-reconnect-audio")).toBeEnabled();
  await page.getByTestId("coach-reconnect-audio").dblclick();

  await expect(page.getByTestId("coach-audio-reconnect-warning")).toContainText("reconnecting browser audio");
  await expect(page.getByTestId("coach-reconnect-audio")).toBeDisabled();
  await expect(page.getByTestId("coach-warning-hangup")).toHaveText("Hang Up");
  await expect(page.getByTestId("transport-state-history")).toContainText("audio_reconnect_required|audio_reconnecting");
  await expect(page.getByTestId("cancel-request-count")).toHaveText("0");
  await expect(page.getByTestId("sdk-hangup-count")).toHaveText("0");
  await expect(page.getByTestId("socket-disconnect-count")).toHaveText("1");
  await expect(page.getByTestId("destructive-disconnect-count")).toHaveText("0");
  await expect(page.getByTestId("manual-hangup-count")).toHaveText("0");
  await expect.poll(async () => Number(await page.getByTestId("provider-status-request-count").textContent())).toBeGreaterThan(0);
  await expectGuidancePreserved(page, guidance);
  await page.screenshot({ path: testInfo.outputPath("ready-no-attach.png"), fullPage: true });
  expectNoBrowserErrors(browserErrors);
});

test("frozen RTP status proof remains nonterminal with recovery and hangup available", async ({ page }, testInfo) => {
  const browserErrors = await mountCoach(page);
  const guidance = await captureNonInitialGuidance(page);
  await stimulate(page, "frozenRtp");
  await expect(page.getByTestId("coach-audio-reconnect-warning")).toContainText("audio interrupted");
  await expect(page.getByTestId("health-report-count")).not.toHaveText("0");
  await expect(page.getByTestId("last-health-packets")).toHaveText("10");
  await expect(page.getByTestId("coach-reconnect-audio")).toBeEnabled();
  await expect(page.getByTestId("coach-warning-hangup")).toBeEnabled();
  await expect(page.getByTestId("cancel-request-count")).toHaveText("0");
  await expect(page.getByTestId("sdk-hangup-count")).toHaveText("0");
  await expect(page.getByTestId("manual-hangup-count")).toHaveText("0");
  await expect.poll(async () => Number(await page.getByTestId("provider-status-request-count").textContent())).toBeGreaterThan(0);
  await expectGuidancePreserved(page, guidance);
  await page.screenshot({ path: testInfo.outputPath("frozen-rtp.png"), fullPage: true });
  expectNoBrowserErrors(browserErrors);
});

test("advancing inbound RTP plus audible playout restores live audio", async ({ page }, testInfo) => {
  const browserErrors = await mountCoach(page);
  const guidance = await captureNonInitialGuidance(page);
  const initialPlayCount = Number(await page.getByTestId("remote-audio-play-count").textContent());
  await stimulate(page, "readyNoAttach");
  await page.getByTestId("coach-reconnect-audio").click();
  await stimulate(page, "advancingRtp");
  await expect(page.getByTestId("coach-audio-reconnect-warning")).toHaveCount(0);
  await expect(page.getByTestId("coach-live-view")).toBeVisible();
  await expect(page.getByTestId("transport-state-history")).toContainText("audio_reconnecting|live");
  await expect.poll(async () => Number(await page.getByTestId("remote-audio-play-count").textContent())).toBeGreaterThan(initialPlayCount);
  const samples = JSON.parse(await page.getByTestId("last-two-health-samples").textContent() ?? "[]") as Array<{ generation: number; packets: number; bytes: number }>;
  expect(samples).toHaveLength(2);
  expect(samples[0].generation).toBe(samples[1].generation);
  expect(samples[1].packets).toBeGreaterThan(samples[0].packets);
  expect(samples[1].bytes).toBeGreaterThan(samples[0].bytes);
  await expect(page.getByTestId("cancel-request-count")).toHaveText("0");
  await expect(page.getByTestId("sdk-hangup-count")).toHaveText("0");
  await expect(page.getByTestId("socket-disconnect-count")).toHaveText("1");
  await expect(page.getByTestId("destructive-disconnect-count")).toHaveText("0");
  await expect(page.getByTestId("manual-hangup-count")).toHaveText("0");
  await expect.poll(async () => Number(await page.getByTestId("provider-status-request-count").textContent())).toBeGreaterThan(0);
  await expectGuidancePreserved(page, guidance);
  await stimulate(page, "readyNoAttach");
  const providerChecksBeforeHangup = await page.getByTestId("provider-status-request-count").textContent();
  await page.getByTestId("coach-warning-hangup").click();
  await expect(page.getByTestId("manual-hangup-count")).toHaveText("1");
  await expect(page.getByTestId("cancel-request-count")).toHaveText("1");
  await expect(page.getByTestId("sdk-hangup-count")).toHaveText("3");
  await expect(page.getByTestId("leg-hangup-counts")).toHaveText("1,2");
  await expect(page.getByTestId("manual-app-sdk-hangup-count")).toHaveText("1");
  await expect(page.getByTestId("local-purge-hangup-count")).toHaveText("2");
  await expect(page.getByTestId("bye-sending-hangup-count")).toHaveText("1");
  await expect(page.getByTestId("server-disconnect-count")).toHaveText("1");
  await expect(page.getByTestId("provider-status-request-count")).toHaveText(providerChecksBeforeHangup ?? "0");
  await expect(page.getByTestId("terminal-source")).toHaveText("manual");
  await expect(page.getByTestId("destructive-disconnect-count")).toHaveText("0");
  await page.screenshot({ path: testInfo.outputPath("advancing-rtp-restored.png"), fullPage: true });
  expectNoBrowserErrors(browserErrors);
});

test("confirmed provider terminal is distinct from explicit manual hangup", async ({ page }, testInfo) => {
  const browserErrors = await mountCoach(page);
  const terminalResponsesBefore = Number(await page.getByTestId("provider-terminal-response-count").textContent());
  await stimulate(page, "providerTerminalConfirmed");

  await expect(page.getByTestId("coach-live-view")).toHaveCount(0);
  await expect(page.getByText(/Call ended/)).toBeVisible();
  await expect(page.getByTestId("provider-terminal-response-baseline")).toHaveText(String(terminalResponsesBefore));
  await expect.poll(async () => Number(await page.getByTestId("provider-terminal-response-count").textContent())).toBeGreaterThan(terminalResponsesBefore);
  await expect(page.getByTestId("terminal-source")).toHaveText("provider");
  await expect(page.getByTestId("manual-hangup-count")).toHaveText("0");
  await expect(page.getByTestId("cancel-request-count")).toHaveText("0");
  await expect(page.getByTestId("sdk-hangup-count")).toHaveText("1");
  await expect(page.getByTestId("manual-app-sdk-hangup-count")).toHaveText("0");
  await expect(page.getByTestId("local-purge-hangup-count")).toHaveText("1");
  await expect(page.getByTestId("bye-sending-hangup-count")).toHaveText("0");
  await expect(page.getByTestId("leg-hangup-counts")).toHaveText("1");
  await expect(page.getByTestId("server-disconnect-count")).toHaveText("1");
  await expect(page.getByTestId("destructive-disconnect-count")).toHaveText("0");
  await page.screenshot({ path: testInfo.outputPath("provider-terminal-confirmed.png"), fullPage: true });
  expectNoBrowserErrors(browserErrors);
});

test("Hang Up uses the explicit user teardown path and never provider proof", async ({ page }, testInfo) => {
  const browserErrors = await mountCoach(page);
  const providerChecksBeforeHangup = await page.getByTestId("provider-status-request-count").textContent();
  await page.getByTestId("coach-hangup").click();

  await expect(page.getByTestId("coach-live-view")).toHaveCount(0);
  await expect(page.getByTestId("manual-hangup-count")).toHaveText("1");
  await expect(page.getByTestId("cancel-request-count")).toHaveText("1");
  await expect(page.getByTestId("provider-status-request-count")).toHaveText(providerChecksBeforeHangup ?? "0");
  await expect(page.getByTestId("sdk-hangup-count")).toHaveText("2");
  await expect(page.getByTestId("manual-app-sdk-hangup-count")).toHaveText("1");
  await expect(page.getByTestId("local-purge-hangup-count")).toHaveText("1");
  await expect(page.getByTestId("bye-sending-hangup-count")).toHaveText("1");
  await expect(page.getByTestId("server-disconnect-count")).toHaveText("1");
  await expect(page.getByTestId("destructive-disconnect-count")).toHaveText("0");
  await expect(page.getByTestId("terminal-source")).toHaveText("manual");
  await expect(page.getByText(/Call ended/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("manual-hangup.png"), fullPage: true });
  expectNoBrowserErrors(browserErrors);
});

test("Mute and unmute update Coach only after SDK acknowledgement", async ({ page }) => {
  const browserErrors = await mountCoach(page);
  const mute = page.getByTestId("coach-mute");
  await mute.click();
  await expect(mute).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("sdk-mute-count")).toHaveText("1");
  await mute.click();
  await expect(mute).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("sdk-unmute-count")).toHaveText("1");
  await expect(page.getByTestId("cancel-request-count")).toHaveText("0");
  await expect(page.getByTestId("sdk-hangup-count")).toHaveText("0");
  await expect(page.getByTestId("destructive-disconnect-count")).toHaveText("0");
  expectNoBrowserErrors(browserErrors);
});

test("Rejected mute stays truthful and never tears down the call", async ({ page }) => {
  const browserErrors = await mountCoach(page);
  const mute = page.getByTestId("coach-mute");
  await stimulate(page, "rejectMute");
  await mute.click();
  await expect(mute).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByText("Mute failed. The homeowner can still hear you.")).toBeVisible();
  await expect(page.getByTestId("sdk-mute-count")).toHaveText("1");
  await expect(page.getByTestId("cancel-request-count")).toHaveText("0");
  await expect(page.getByTestId("sdk-hangup-count")).toHaveText("0");
  await expect(page.getByTestId("destructive-disconnect-count")).toHaveText("0");
  expectNoBrowserErrors(browserErrors);
});

test("Rejected unmute preserves muted truth and never tears down the call", async ({ page }) => {
  const browserErrors = await mountCoach(page);
  const mute = page.getByTestId("coach-mute");
  await mute.click();
  await expect(mute).toHaveAttribute("aria-pressed", "true");
  await stimulate(page, "rejectUnmute");
  await mute.click();
  await expect(mute).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Unmute failed. You are still muted.")).toBeVisible();
  await expect(page.getByTestId("sdk-unmute-count")).toHaveText("1");
  await expect(page.getByTestId("cancel-request-count")).toHaveText("0");
  await expect(page.getByTestId("sdk-hangup-count")).toHaveText("0");
  await expect(page.getByTestId("destructive-disconnect-count")).toHaveText("0");
  expectNoBrowserErrors(browserErrors);
});

test("Hold warns while durable acknowledgement is unknown without blocking controls", async ({ page }, testInfo) => {
  const browserErrors = await mountCoach(page);
  const guidance = await captureNonInitialGuidance(page);
  await stimulate(page, "loseHoldAck");
  await page.getByTestId("coach-hold").click();
  await expect(page.getByTestId("coach-hold")).toHaveText(/Resume/);
  await expect(page.getByTestId("coach-hold")).toBeEnabled();
  await expect(page.getByText("The call is held, but Jitter has not confirmed the hold yet.")).toBeVisible();
  await expect(page.getByTestId("coach-hangup")).toBeEnabled();
  await stimulate(page, "confirmHealth");
  await expect(page.getByTestId("coach-hold")).toBeEnabled();
  await stimulate(page, "readyNoAttach");
  await page.getByTestId("coach-reconnect-audio").click();
  await stimulate(page, "heldReconnect");
  await expect(page.getByTestId("coach-hold")).toHaveText(/Resume/);
  await expect(page.getByTestId("coach-audio-reconnect-warning")).toHaveCount(0);
  await expect(page.getByTestId("cancel-request-count")).toHaveText("0");
  await expect(page.getByTestId("destructive-disconnect-count")).toHaveText("0");
  await expectGuidancePreserved(page, guidance);
  await page.screenshot({ path: testInfo.outputPath("hold-sync-and-restored.png"), fullPage: true });
  expectNoBrowserErrors(browserErrors);
});

test("Direct Hold and Resume failures preserve truth until exact provider updates", async ({ page }) => {
  const browserErrors = await mountCoach(page);
  const hold = page.getByTestId("coach-hold");
  await stimulate(page, "rejectHold");
  await hold.click();
  await expect(page.getByText("Hold failed. The call is still live.")).toBeVisible();
  await expect(hold).toHaveText(/^Hold$/);
  await expect(hold).toBeEnabled();
  await expect(page.getByTestId("coach-hangup")).toBeEnabled();

  await stimulate(page, "providerHeldUpdate");
  await expect(hold).toHaveText(/Resume/);
  await stimulate(page, "rejectResume");
  await hold.click();
  await expect(page.getByText("Resume failed. The call is still on hold.")).toBeVisible();
  await expect(hold).toHaveText(/Resume/);
  await expect(hold).toBeEnabled();

  await stimulate(page, "providerActiveUpdate");
  await expect(hold).toHaveText(/^Hold$/);
  await expect(page.getByTestId("coach-hangup")).toBeEnabled();
  await expect(page.getByTestId("cancel-request-count")).toHaveText("0");
  await expect(page.getByTestId("sdk-hangup-count")).toHaveText("0");
  await expect(page.getByTestId("destructive-disconnect-count")).toHaveText("0");
  expectNoBrowserErrors(browserErrors);
});

test("Hold reapply failure remains live and visible without duplicate teardown", async ({ page }, testInfo) => {
  const browserErrors = await mountCoach(page);
  const guidance = await captureNonInitialGuidance(page);
  await page.getByTestId("coach-hold").click();
  await expect(page.getByTestId("coach-hold")).toHaveText(/Resume/);
  await stimulate(page, "readyNoAttach");
  await page.getByTestId("coach-reconnect-audio").click();
  await stimulate(page, "holdReapplyFailure");
  await expect(page.getByTestId("coach-hold")).toHaveText(/^Hold$/);
  await expect(page.getByText("Hold could not be restored after audio recovery. The call is still live.")).toBeVisible();
  await expect(page.getByTestId("coach-live-view")).toBeVisible();
  await expect(page.getByTestId("coach-warning-hangup")).toBeEnabled();
  await expect(page.getByTestId("cancel-request-count")).toHaveText("0");
  await expect(page.getByTestId("sdk-hangup-count")).toHaveText("0");
  await expect(page.getByTestId("destructive-disconnect-count")).toHaveText("0");
  await expectGuidancePreserved(page, guidance);
  await page.screenshot({ path: testInfo.outputPath("hold-reapply-failure.png"), fullPage: true });
  expectNoBrowserErrors(browserErrors);
});

for (const viewport of [{ width: 375, height: 667 }, { width: 375, height: 812 }]) {
  test(`keeps interrupted and reconnecting controls accessible at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    const browserErrors = await mountCoach(page);
    await page.setViewportSize(viewport);
    await page.evaluate(() => {
      document.documentElement.classList.add("dark");
      document.documentElement.style.zoom = "1.1";
    });
    const guidance = await captureNonInitialGuidance(page);
    await stimulate(page, "readyNoAttach");
    const alert = page.getByTestId("coach-audio-reconnect-warning");
    await expect(alert).toHaveAttribute("role", "alert");
    await expect(page.getByTestId("coach-reconnect-audio")).toBeEnabled();
    await expect(page.getByTestId("coach-warning-hangup")).toBeEnabled();
    await page.getByTestId("coach-reconnect-audio").focus();
    await expect(page.getByTestId("coach-reconnect-audio")).toBeFocused();
    const interruptedOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(interruptedOverflow).toBeLessThanOrEqual(1);
    await page.getByTestId("coach-reconnect-audio").click();
    await expect(page.getByTestId("coach-reconnect-audio")).toBeDisabled();
    await expect(page.getByTestId("coach-warning-hangup")).toBeEnabled();
    await expectGuidancePreserved(page, guidance);
    const reconnectingOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(reconnectingOverflow).toBeLessThanOrEqual(1);
    await expect(page.getByTestId("cancel-request-count")).toHaveText("0");
    await expect(page.getByTestId("sdk-hangup-count")).toHaveText("0");
    expectNoBrowserErrors(browserErrors);
  });
}
