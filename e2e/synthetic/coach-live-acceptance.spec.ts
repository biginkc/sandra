import { expect, test, type Page, type TestInfo } from "@playwright/test";
import tailwindcss from "@tailwindcss/postcss";
import * as esbuild from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import postcss from "postcss";

type StreamResult = {
  eventCount: number;
  latencies: number[];
  receiptGaps: number[];
  elapsedMs: number;
};

type AcceptanceMetrics = {
  generatedAt: string;
  wire: { strictDigest: boolean; scriptVersion: string; eventPath: string };
  transcript: {
    eventCount: number;
    gapMs: { min: number; max: number };
    visibleLatencyMs: { p50: number; p95: number; max: number };
    elapsedMs: number;
  };
  objectionPrompt: {
    eventToVisibleMs: number;
    duplicateCardCount: number;
    olderEventPreservedNewer: boolean;
    mismatchedDigestRejected: boolean;
    previousSessionIsolated: boolean;
  };
  typing: { focusPreserved: boolean; firstValue: string; retypedValue: string };
  reconnect: {
    checkingVisibleWithinMs: number;
    amberAfter15s: boolean;
    statusErrorCodeVisible: string;
    recoverActionCount: number;
    remoteAudioAttached: boolean;
    remoteAudioPlaying: boolean;
    hangupWorked: boolean;
  };
};

let compiledCss = "";
let behaviorBundle = "";
let audioBundle = "";

async function installSyntheticProcessShim(page: Page): Promise<void> {
  // The source feature flags deliberately guard `process` so a browser bundle
  // can run without a Node shim. Install the same public env values that
  // esbuild inlined into this acceptance bundle before loading it, keeping
  // the strict branch active at runtime instead of accidentally taking the
  // rollout-compatible default.
  await page.addScriptTag({
    content: `window.process = { env: { NEXT_PUBLIC_COACH_WIRE_DIGEST_STRICT: "1", NEXT_PUBLIC_COACH_UI_ENABLED: "1", NEXT_PUBLIC_SOFTPHONE_TRANSPORT: "jitter" } };`,
  });
}

function boundaryPlugins() {
  return [{
    name: "synthetic-coach-browser-boundaries",
    setup(build: esbuild.PluginBuild) {
      build.onResolve({ filter: /^@sentry\/nextjs$/ }, () => ({
        path: path.resolve(process.cwd(), "e2e/synthetic/fixtures/sentry-browser-stub.ts"),
      }));
      build.onResolve({ filter: /coach-context-actions$/ }, () => ({
        path: path.resolve(process.cwd(), "e2e/synthetic/fixtures/coach-context-actions-browser-stub.ts"),
      }));
      build.onResolve({ filter: /coach-script-actions$/ }, () => ({
        path: path.resolve(process.cwd(), "e2e/synthetic/fixtures/coach-script-actions-browser-stub.ts"),
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
  }];
}

test.beforeAll(async () => {
  const globalsPath = path.resolve(process.cwd(), "src/app/globals.css");
  const globalsSource = await readFile(globalsPath, "utf8");
  compiledCss = (await postcss([tailwindcss()]).process(globalsSource, { from: globalsPath })).css;

  const shared = {
    bundle: true,
    platform: "browser" as const,
    external: ["crypto"],
    format: "iife" as const,
    target: "chrome120",
    jsx: "automatic" as const,
    jsxImportSource: "react",
    alias: {
      "@/lib/coach/recommendation-action": path.resolve(process.cwd(), "e2e/synthetic/fixtures/coach-recommendation-action-stub.ts"),
      "@": path.resolve(process.cwd(), "src"),
    },
    plugins: boundaryPlugins(),
    define: {
      "process.env.NODE_ENV": '"test"',
      "process.env.NEXT_PUBLIC_COACH_SCRIPT_V2": '""',
      "process.env.NEXT_PUBLIC_COACH_WIRE_DIGEST_STRICT": '"1"',
    },
    write: false,
    logLevel: "silent" as const,
  };

  const behavior = await esbuild.build({
    ...shared,
    entryPoints: [path.resolve(process.cwd(), "e2e/synthetic/fixtures/coach-live-behavior-harness.tsx")],
  });
  const behaviorOutput = behavior.outputFiles?.[0];
  if (!behaviorOutput) throw new Error("Synthetic behavior harness did not produce a bundle");
  behaviorBundle = behaviorOutput.text;

  const audio = await esbuild.build({
    ...shared,
    entryPoints: [path.resolve(process.cwd(), "e2e/synthetic/fixtures/coach-audio-acceptance-harness.tsx")],
    define: {
      ...shared.define,
      "process.env.NEXT_PUBLIC_SOFTPHONE_TRANSPORT": '"jitter"',
      "process.env.NEXT_PUBLIC_COACH_UI_ENABLED": '"1"',
    },
  });
  const audioOutput = audio.outputFiles?.[0];
  if (!audioOutput) throw new Error("Synthetic audio harness did not produce a bundle");
  audioBundle = audioOutput.text;
});

async function mountBehavior(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.setContent(`<style>${compiledCss}</style><div id="root" data-acceptance-typing="true"></div>`);
  await installSyntheticProcessShim(page);
  await page.addScriptTag({ content: behaviorBundle });
  await expect(page.getByTestId("coach-live-view")).toBeVisible();
  await expect(page.getByTestId("current-section-title")).toHaveText("Open the call");
  await expect(page.getByTestId("entry-chip-cold_caller_name")).toBeVisible();
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function range(values: number[]): { min: number; max: number } {
  return { min: Math.min(...values), max: Math.max(...values) };
}

async function mountRetainedAudio(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.clock.install();
  await page.route("http://synthetic.local/**", (route) => route.fulfill({
    status: 200,
    contentType: "text/html",
    body: `<style>${compiledCss}</style><div id="root" data-defer-recovery="true" data-provider-status-error-code="synthetic_provider_status_unavailable"></div>`,
  }));
  await page.goto("http://synthetic.local/");
  await installSyntheticProcessShim(page);
  await page.addScriptTag({ content: audioBundle });
  // The first load creates the synthetic retained capability. Reloading the
  // same origin then exercises the actual sessionStorage hydration path.
  await expect(page.getByTestId("coach-live-view")).toBeVisible();
  await page.reload();
  await page.addScriptTag({ content: audioBundle });
}

async function writeMetrics(metrics: AcceptanceMetrics, testInfo: TestInfo): Promise<void> {
  const metricsPath = path.resolve(process.cwd(), "test-results/coach-live-acceptance-metrics.json");
  await mkdir(path.dirname(metricsPath), { recursive: true });
  await writeFile(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`, "utf8");
  await testInfo.attach("coach-live-acceptance-metrics", {
    path: metricsPath,
    contentType: "application/json",
  });
}

test.setTimeout(60_000);

test("proves the synthetic live-coach machine acceptance path", async ({ page }, testInfo) => {
  testInfo.setTimeout(60_000);
  const metrics: AcceptanceMetrics = {
    generatedAt: new Date().toISOString(),
    wire: { strictDigest: true, scriptVersion: "1.2.3", eventPath: "use-coach-channel → parseCoachEvent → coachReducer → DOM" },
    transcript: { eventCount: 0, gapMs: { min: 0, max: 0 }, visibleLatencyMs: { p50: 0, p95: 0, max: 0 }, elapsedMs: 0 },
    objectionPrompt: { eventToVisibleMs: 0, duplicateCardCount: 0, olderEventPreservedNewer: false, mismatchedDigestRejected: false, previousSessionIsolated: false },
    typing: { focusPreserved: false, firstValue: "", retypedValue: "" },
    reconnect: { checkingVisibleWithinMs: 0, amberAfter15s: false, statusErrorCodeVisible: "", recoverActionCount: 0, remoteAudioAttached: false, remoteAudioPlaying: false, hangupWorked: false },
  };

  try {
    await mountBehavior(page);

    const replayPromise = page.evaluate(() => window.coachBehaviorHarness.replayAcceptanceConversation() as Promise<StreamResult>);
    const input = page.getByTestId("entry-input-cold_caller_name");
    await page.getByTestId("entry-chip-cold_caller_name").click();
    await expect(input).toBeFocused();
    await page.evaluate(() => {
      const editor = document.querySelector<HTMLInputElement>("[data-testid='entry-input-cold_caller_name']");
      (window as unknown as { coachTypingFocusLost: boolean }).coachTypingFocusLost = false;
      editor?.addEventListener("blur", () => {
        (window as unknown as { coachTypingFocusLost: boolean }).coachTypingFocusLost = true;
      });
    });
    await page.keyboard.type("Maria Gonzalez", { delay: 60 });
    await expect(input).toBeFocused();
    const firstValue = await input.inputValue();

    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("Backspace");
    await page.keyboard.type("Maria Gonzalez", { delay: 60 });
    await expect(input).toBeFocused();
    const retypedValue = await input.inputValue();
    const focusLost = await page.evaluate(() => (window as unknown as { coachTypingFocusLost: boolean }).coachTypingFocusLost);
    metrics.typing = { focusPreserved: !focusLost, firstValue, retypedValue };
    expect(firstValue).toBe("Maria Gonzalez");
    expect(retypedValue).toBe("Maria Gonzalez");
    expect(focusLost).toBe(false);
    await input.press("Enter");
    await expect(page.getByTestId("current-section-script")).toContainText("Maria Gonzalez");

    const stream = await replayPromise;
    const transcriptLatencies = {
      p50: percentile(stream.latencies, 0.5),
      p95: percentile(stream.latencies, 0.95),
      max: Math.max(...stream.latencies),
    };
    const gaps = range(stream.receiptGaps);
    metrics.transcript = {
      eventCount: stream.eventCount,
      gapMs: gaps,
      visibleLatencyMs: transcriptLatencies,
      elapsedMs: stream.elapsedMs,
    };
    expect(stream.eventCount).toBeGreaterThanOrEqual(30);
    expect(gaps.min).toBeGreaterThanOrEqual(150);
    expect(gaps.max).toBeLessThanOrEqual(400);
    expect(transcriptLatencies.p95).toBeLessThan(250);
    console.log(`coach-live transcript metrics: events=${stream.eventCount} gaps=${gaps.min.toFixed(1)}-${gaps.max.toFixed(1)}ms p50=${transcriptLatencies.p50.toFixed(1)}ms p95=${transcriptLatencies.p95.toFixed(1)}ms max=${transcriptLatencies.max.toFixed(1)}ms elapsed=${stream.elapsedMs.toFixed(1)}ms`);

    const objectionLatency = await page.evaluate(() => window.coachBehaviorHarness.measureAcceptancePrompt() as Promise<number>);
    await expect(page.getByTestId("coach-objection-prompt-label")).toHaveText("Price concern");
    metrics.objectionPrompt.eventToVisibleMs = objectionLatency;
    await page.evaluate(() => window.coachBehaviorHarness.newerObjectionPrompt());
    await expect(page.getByTestId("coach-objection-prompt-label")).toHaveText("Timing concern");
    await page.evaluate(() => window.coachBehaviorHarness.olderObjectionPrompt());
    await expect(page.getByTestId("coach-objection-prompt-label")).toHaveText("Timing concern");
    metrics.objectionPrompt.olderEventPreservedNewer = true;
    metrics.objectionPrompt.duplicateCardCount = await page.getByTestId("coach-objection-prompt").count();
    expect(metrics.objectionPrompt.duplicateCardCount).toBe(1);
    await expect(page.getByTestId("coach-recommendations")).toHaveCount(0);
    await page.evaluate(() => window.coachBehaviorHarness.motivationPrompt());
    const approvedReplies = JSON.parse(await readFile(path.resolve(process.cwd(), "src/lib/coach/live-coach-replies.approved.json"), "utf8")) as { sets: { motivation: { replies: { text: string }[] } } };
    await expect(page.getByTestId("coach-motivation-replies").getByRole("listitem")).toHaveText(approvedReplies.sets.motivation.replies.map((reply) => reply.text));
    await expect(page.getByTestId("coach-card-tray")).toContainText("Timing concern");
    await expect(page.getByTestId("coach-objection-prompt").getByRole("listitem")).toHaveCount(0);
    await page.getByTestId("coach-objection-prompt-dismiss").click();
    await expect(page.getByTestId("coach-objection-prompt")).toHaveCount(0);
    await expect(page.getByTestId("coach-motivation-prompt")).toBeVisible();
    await page.getByTestId("coach-motivation-prompt-dismiss").click();
    await expect(page.getByTestId("coach-motivation-prompt")).toHaveCount(0);
    // A duplicate of the dismissed card must not bring it back; a genuinely newer card shows.
    await page.evaluate(() => window.coachBehaviorHarness.newerObjectionPrompt());
    await page.waitForTimeout(50);
    await expect(page.getByTestId("coach-objection-prompt")).toHaveCount(0);
    await page.evaluate(() => window.coachBehaviorHarness.afterDismissObjectionPrompt());
    await expect(page.getByTestId("coach-objection-prompt-label")).toHaveText("Timing concern");

    await page.evaluate(() => window.coachBehaviorHarness.mismatchedDigestObjectionPrompt());
    await page.waitForTimeout(50);
    metrics.objectionPrompt.mismatchedDigestRejected = await page.getByTestId("coach-objection-prompt-label").evaluate((element) => element.textContent !== "Wrong digest");
    expect(metrics.objectionPrompt.mismatchedDigestRejected).toBe(true);

    await page.getByTestId("coach-collapse").click();
    await page.getByTestId("collapsed-new-call").click();
    await expect(page.getByTestId("synthetic-active-call")).toHaveText("synthetic-call-2");
    await page.evaluate(() => window.coachBehaviorHarness.previousCallObjectionPrompt());
    await page.waitForTimeout(50);
    metrics.objectionPrompt.previousSessionIsolated = await page.getByTestId("coach-objection-prompt").count() === 0;
    expect(metrics.objectionPrompt.previousSessionIsolated).toBe(true);
    console.log(`coach-live objection metrics: event-to-visible=${objectionLatency.toFixed(1)}ms duplicate-cards=${metrics.objectionPrompt.duplicateCardCount} older-preserved=${metrics.objectionPrompt.olderEventPreservedNewer} wrong-digest-rejected=${metrics.objectionPrompt.mismatchedDigestRejected} previous-session-isolated=${metrics.objectionPrompt.previousSessionIsolated}`);

    await mountRetainedAudio(page);
    const checkingStarted = Date.now();
    await expect(page.getByTestId("coach-audio-reconnect-warning")).toBeVisible({ timeout: 1_000 });
    await expect(page.getByTestId("coach-audio-reconnect-warning")).toContainText("Checking call status…");
    await expect(page.getByTestId("coach-reconnect-audio")).toBeVisible();
    await expect(page.getByTestId("coach-warning-hangup")).toBeVisible();
    const checkingVisibleWithinMs = Date.now() - checkingStarted;
    metrics.reconnect.checkingVisibleWithinMs = checkingVisibleWithinMs;
    await expect(page.getByText("Status check: synthetic_provider_status_unavailable", { exact: true })).toBeVisible();
    metrics.reconnect.statusErrorCodeVisible = "synthetic_provider_status_unavailable";

    await page.clock.runFor(15_001);
    await expect(page.getByTestId("coach-audio-reconnect-warning")).toContainText("Call live · audio interrupted");
    const warningClasses = await page.getByTestId("coach-audio-reconnect-warning").getAttribute("class");
    metrics.reconnect.amberAfter15s = warningClasses?.includes("--coach-amber") ?? false;
    expect(metrics.reconnect.amberAfter15s).toBe(true);

    await page.getByTestId("coach-reconnect-audio").click();
    await expect(page.getByTestId("recover-audio-count")).toHaveText("1");
    await expect(page.getByTestId("transport-state-history")).toContainText("audio_reconnect_required|audio_reconnecting");
    await expect(page.getByTestId("remote-audio-attached")).toHaveText("attached");
    await expect(page.getByTestId("remote-audio-playing")).toHaveText("playing");
    metrics.reconnect.recoverActionCount = Number(await page.getByTestId("recover-audio-count").textContent());
    metrics.reconnect.remoteAudioAttached = true;
    metrics.reconnect.remoteAudioPlaying = true;
    await expect(page.getByTestId("coach-live-view")).toBeVisible();

    await page.getByTestId("coach-hangup").click();
    await expect(page.getByTestId("coach-live-view")).toHaveCount(0);
    metrics.reconnect.hangupWorked = true;
    console.log(`coach-live reconnect metrics: checking=${checkingVisibleWithinMs}ms amber-after-15s=${metrics.reconnect.amberAfter15s} status-error=${metrics.reconnect.statusErrorCodeVisible} recover-actions=${metrics.reconnect.recoverActionCount} remote-audio=attached+playing hangup=${metrics.reconnect.hangupWorked}`);
  } finally {
    await writeMetrics(metrics, testInfo);
    console.log(`coach-live acceptance metrics JSON: ${JSON.stringify(metrics)}`);
  }
});
