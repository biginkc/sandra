import { expect, test } from "@playwright/test";
import * as esbuild from "esbuild";
import path from "node:path";

let bundle = "";
test.beforeAll(async () => {
  const result = await esbuild.build({
    entryPoints: [path.resolve("e2e/synthetic/fixtures/norma-recordings-harness.tsx")],
    bundle: true, platform: "browser", format: "iife", target: "chrome120", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"test"' }, write: false,
  });
  bundle = result.outputFiles[0].text;
});

test("recordings load on demand and failed audio can be retried without external URLs", async ({ page }) => {
  const requests: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    requests.push(url.pathname);
    // Every request is fulfilled locally; no provider or production access.
    if (url.pathname.endsWith("/recordings")) {
      await route.fulfill({ json: { recordings: [{ attempt: 1, state: "pending" }, { attempt: 2, state: "failed" }] } });
    } else if (/\/recordings\/[12]$/.test(url.pathname)) {
      await route.fulfill({ status: 404, json: { error: "Recording is not yet available" } });
    } else {
      await route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
    }
  });
  await page.goto("https://synthetic.invalid/lead");
  await page.addScriptTag({ content: bundle });
  await expect(page.getByRole("button", { name: "Load Norma recordings" })).toBeVisible();
  expect(requests.filter((url) => url.includes("recordings"))).toEqual([]);
  await page.getByRole("button", { name: "Load Norma recordings" }).click();
  await expect(page.locator("audio")).toHaveCount(2);
  await expect(page.getByText("Recording is still processing or awaiting an availability check.")).toBeVisible();
  await expect(page.getByText("Recording availability could not be checked. Playback may still work; try again later.")).toBeVisible();
  const audio = page.locator("audio").first();
  await expect(audio).toHaveAttribute("preload", "none");
  await expect(audio).toHaveAttribute("src", "/api/norma/requests/11111111-1111-4111-8111-111111111111/recordings/1");
  await audio.evaluate((element: HTMLAudioElement) => element.load());
  await expect(page.getByRole("alert")).toContainText("Recording unavailable");
  await page.getByRole("button", { name: "Reload recordings" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.locator("audio")).toHaveCount(2);
  expect(errors).toEqual([]);
});
