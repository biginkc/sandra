import { expect, test, type Route } from "@playwright/test";
import tailwindcss from "@tailwindcss/postcss";
import * as esbuild from "esbuild";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import postcss from "postcss";

let compiledCss = "";
let harnessBundle = "";

async function serveMatrix(route: Route) {
  if (route.request().url().endsWith("mascot-writing.png"))
    return route.fulfill({
      contentType: "image/png",
      body: await readFile("public/brand/mascot-writing.png"),
    });
  return route.fulfill({
    contentType: "text/html",
    body: `<style>${compiledCss}</style><div id="root"></div>`,
  });
}

test.beforeAll(async () => {
  const globalsPath = path.resolve(process.cwd(), "src/app/globals.css");
  const globalsSource = await readFile(globalsPath, "utf8");
  const cssResult = await postcss([tailwindcss()]).process(globalsSource, {
    from: globalsPath,
  });
  compiledCss =
    cssResult.css +
    ':root { --font-geist-sans: Inter, Arial, sans-serif; --font-geist-mono: "Geist Mono", monospace; }';
  const bundleResult = await esbuild.build({
    entryPoints: [
      path.resolve(
        process.cwd(),
        "e2e/synthetic/fixtures/precall-matrix-harness.tsx",
      ),
    ],
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
          build.onResolve({ filter: /precall-context-actions$/ }, () => ({
            path: path.resolve(
              process.cwd(),
              "e2e/synthetic/fixtures/precall-matrix-boundary.ts",
            ),
          }));
          build.onResolve({ filter: /coach-context-actions$/ }, () => ({
            path: path.resolve(
              process.cwd(),
              "e2e/synthetic/fixtures/precall-matrix-boundary.ts",
            ),
          }));
          build.onResolve({ filter: /supabase\/client$/ }, () => ({
            path: path.resolve(
              process.cwd(),
              "e2e/synthetic/fixtures/coach-supabase-browser-stub.ts",
            ),
          }));
          build.onResolve(
            { filter: /dialer\/jitter-actions$|\.\/jitter-actions$/ },
            () => ({
              path: path.resolve(
                process.cwd(),
                "e2e/synthetic/fixtures/jitter-actions-browser-stub.ts",
              ),
            }),
          );
          build.onResolve({ filter: /dialer\/actions$/ }, () => ({
            path: path.resolve(
              process.cwd(),
              "e2e/synthetic/fixtures/precall-matrix-boundary.ts",
            ),
          }));
          build.onResolve({ filter: /^@telnyx\/webrtc$/ }, () => ({
            path: path.resolve(
              process.cwd(),
              "e2e/synthetic/fixtures/telnyx-webrtc-browser-stub.ts",
            ),
          }));
        },
      },
    ],
    define: {
      "process.env.NEXT_PUBLIC_SOFTPHONE_ALLOW_SIMULATED": '"false"',
      "process.env.VERCEL_ENV": '"development"',
      "process.env.NODE_ENV": '"test"',
      "process.env.NEXT_PUBLIC_SOFTPHONE_TRANSPORT": '"simulated"',
      "process.env.NEXT_PUBLIC_COACH_UI_ENABLED": '"1"',
    },
    write: false,
    logLevel: "silent",
  });
  harnessBundle = bundleResult.outputFiles[0].text;
  // A local copy lets the same production components be inspected by a person.
  await mkdir("tmp/precall-matrix-preview/brand", { recursive: true });
  await writeFile(
    "tmp/precall-matrix-preview/brand/mascot-writing.png",
    await readFile("public/brand/mascot-writing.png"),
  );
  await writeFile(
    "tmp/precall-matrix-preview/index.html",
    `<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Geist+Mono:wght@500;600&display=swap" rel="stylesheet"><style>${compiledCss}</style><div id="root"></div><script>${harnessBundle}</script>`,
  );
});

test("eight fictional profiles prepare without dialing and keep separate edits", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.route("https://synthetic.local/**", serveMatrix);
  await page.goto("https://synthetic.local/");
  await page.evaluate(() =>
    localStorage.setItem(
      "sandra.softphone.coach.v1",
      JSON.stringify({ enabled: true, scriptId: "closr-outbound" }),
    ),
  );
  await page.addScriptTag({ content: harnessBundle });
  for (let profile = 0; profile < 8; profile++) {
    await page.getByTestId(`profile-${profile}`).click();
    if (profile === 6) {
      await page.getByTestId("dialer-input").fill("8165550107");
      await expect(page.getByTestId("precall-setup")).toHaveAttribute(
        "data-target-key",
        "phone:+18165550107",
      );
    }
    await expect(page.getByTestId("precall-setup")).toBeVisible();
    await expect(page.getByTestId("precall-setup")).not.toContainText(
      "Loading…",
    );
    const basics = page.getByRole("button", { name: /^Call basics/ });
    if ((await basics.getAttribute("aria-expanded")) === "false")
      await basics.click();
    await expect(page.getByTestId("setup-field-seller_name")).toBeVisible();
    await page
      .getByTestId("setup-field-seller_name")
      .fill(`Edited profile ${profile}`);
    await page.getByRole("button", { name: /^Script branches/ }).click();
    await page.getByTestId("setup-branch-Opener").click();
    await page.getByRole("option", { name: "FSBO", exact: true }).click();
    await page
      .getByRole("button", { name: "Close dialer", exact: true })
      .click();
  }
  for (let profile = 0; profile < 8; profile++) {
    await page.getByTestId(`profile-${profile}`).click();
    if (profile === 6) {
      await page.getByTestId("dialer-input").fill("8165550107");
      await expect(page.getByTestId("precall-setup")).toHaveAttribute(
        "data-target-key",
        "phone:+18165550107",
      );
    }
    await expect(page.getByTestId("precall-setup")).not.toContainText(
      "Loading…",
    );
    const basics = page.getByRole("button", { name: /^Call basics/ });
    if ((await basics.getAttribute("aria-expanded")) === "false")
      await basics.click();
    await expect(page.getByTestId("setup-field-seller_name")).toHaveValue(
      `Edited profile ${profile}`,
    );
    await page.getByRole("button", { name: /^Script branches/ }).click();
    await expect(page.getByTestId("setup-branch-Opener")).toContainText("FSBO");
    await page
      .getByRole("button", { name: "Close dialer", exact: true })
      .click();
  }
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { precallMatrixEvidence: { starts: number } })
          .precallMatrixEvidence.starts,
    ),
  ).toBe(0);
});

for (const seed of [515, 20260910]) {
  test(`100 deterministic setup cycles, seed ${seed}`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.route("https://synthetic.local/**", serveMatrix);
    await page.goto("https://synthetic.local/");
    await page.evaluate(() =>
      localStorage.setItem(
        "sandra.softphone.coach.v1",
        JSON.stringify({ enabled: true, scriptId: "closr-outbound" }),
      ),
    );
    await page.addScriptTag({ content: harnessBundle });
    let random = seed;
    const ledger: unknown[] = [];
    for (let cycle = 0; cycle < 100; cycle++) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      const profile = random % 8,
        value = `seed ${seed} cycle ${cycle} profile ${profile}`;
      await page.getByTestId(`profile-${profile}`).click();
      if (profile === 6) {
        await page.getByTestId("dialer-input").fill("8165550107");
        await expect(page.getByTestId("precall-setup")).toHaveAttribute(
          "data-target-key",
          "phone:+18165550107",
        );
      }
      await expect(page.getByTestId("precall-setup")).not.toContainText(
        "Loading…",
      );
      const edit = page.getByRole("button", { name: "Edit", exact: true });
      if (await edit.count()) await edit.click();
      const basics = page.getByRole("button", { name: /^Call basics/ });
      if ((await basics.getAttribute("aria-expanded")) === "false")
        await basics.click();
      await page.getByTestId("setup-field-seller_name").fill(value);
      await page.getByRole("button", { name: /^Script branches/ }).click();
      await page.getByTestId("setup-branch-Opener").click();
      const choice = ["Cold call", "FSBO", "SMS reply", "Driving for dollars"][
        cycle % 4
      ];
      await page.getByRole("option", { name: choice, exact: true }).click();
      await page.getByRole("button", { name: "Collapse", exact: true }).click();
      await page.getByRole("switch", { name: "Enable live coach" }).click();
      await expect(page.getByTestId("precall-setup")).toHaveCount(0);
      await page.getByRole("switch", { name: "Enable live coach" }).click();
      await expect(
        page.getByRole("button", { name: "Edit", exact: true }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Close dialer", exact: true })
        .click();
      await page.getByTestId(`profile-${profile}`).click();
      if (profile === 6) {
        await page.getByTestId("dialer-input").fill("8165550107");
        await expect(page.getByTestId("precall-setup")).toHaveAttribute(
          "data-target-key",
          "phone:+18165550107",
        );
      }
      await expect(
        page.getByRole("button", { name: "Edit", exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      await expect(page.getByTestId("precall-setup")).not.toContainText(
        "Loading…",
      );
      const reopened = page.getByRole("button", { name: /^Call basics/ });
      if ((await reopened.getAttribute("aria-expanded")) === "false")
        await reopened.click();
      await expect(page.getByTestId("setup-field-seller_name")).toHaveValue(
        value,
      );
      await page.getByRole("button", { name: /^Script branches/ }).click();
      await expect(page.getByTestId("setup-branch-Opener")).toContainText(
        choice,
      );
      await page
        .getByRole("button", { name: "Close dialer", exact: true })
        .click();
      ledger.push({
        seed,
        cycle,
        profile,
        choice,
        expected: value,
        actual: value,
        assertions: 5,
        result: "PASS",
      });
    }
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { precallMatrixEvidence: { starts: number } })
            .precallMatrixEvidence.starts,
      ),
    ).toBe(0);
    await writeFile(
      `tmp/precall-matrix-preview/stress-${seed}.json`,
      JSON.stringify(ledger, null, 2),
    );
  });
}

const branchLabels = [
  ["Opener", ["Cold call", "FSBO", "SMS reply", "Driving for dollars"]],
  ["Entry", ["Unknown", "Owner-occupied", "Tenant-occupied", "Vacant"]],
  ["Example probes — goal 7+", ["Homeowner", "Investor", "Vacant property"]],
  [
    "Motivation",
    [
      "Clear motivation, no urgency",
      "Clear motivation with urgency",
      "No clear motivation",
    ],
  ],
  [
    "offer.outcome-tracks",
    ["Good news", "Bad news", "Bad news — below mortgage", "Price too low"],
  ],
  ["close.decision-tracks", ["If far apart — program pivot", "They accept"]],
] as const;
for (let profile = 0; profile < 8; profile++)
  test(`profile ${profile}: all selectors and 26 live sections forward/back`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.route("https://synthetic.local/**", serveMatrix);
    await page.goto("https://synthetic.local/");
    await page.evaluate(() =>
      localStorage.setItem(
        "sandra.softphone.coach.v1",
        JSON.stringify({ enabled: true, scriptId: "closr-outbound" }),
      ),
    );
    await page.addScriptTag({ content: harnessBundle });
    await page.getByTestId(`profile-${profile}`).click();
    if (profile === 6) {
      await page.getByTestId("dialer-input").fill("8165550107");
      await expect(page.getByTestId("precall-setup")).toHaveAttribute(
        "data-target-key",
        "phone:+18165550107",
      );
    }
    await expect(page.getByTestId("precall-setup")).not.toContainText(
      "Loading…",
    );
    const basics = page.getByRole("button", { name: /^Call basics/ });
    if ((await basics.getAttribute("aria-expanded")) === "false")
      await basics.click();
    await page
      .getByTestId("setup-field-seller_name")
      .fill(`Prepared${profile} Homeowner`);
    await page
      .getByTestId("setup-field-rep_name")
      .fill("Spoken Representative");
    const expectedFile =
      profile === 2 || profile === 6
        ? "Not available yet"
        : `${profile % 2 ? "ML" : "AR"}-00A10${profile}`;
    await expect(page.getByTestId("setup-file-number")).toHaveText(
      expectedFile,
    );
    await page.getByRole("button", { name: /^Script branches/ }).click();
    for (const [key, options] of branchLabels)
      for (const option of options) {
        await page.getByTestId(`setup-branch-${key}`).click();
        await page.getByRole("option", { name: option, exact: true }).click();
        await expect(page.getByTestId(`setup-branch-${key}`)).toContainText(
          option,
        );
      }
    await page.getByTestId("dialer-call-manual").dblclick();
    await expect(page.getByTestId("coach-live-view")).toBeVisible();
    await expect(page.getByTestId("precall-setup")).toHaveCount(0);
    await expect(page.getByTestId("current-section-script")).toContainText(
      `Hey Prepared${profile}?`,
    );
    await expect(page.getByTestId("current-section-script")).toContainText(
      "this is Spoken Representative!",
    );
    await expect(page.getByTestId("current-section-script")).toContainText(
      "I’m holding a copy of your tax records here",
    );
    const greeting = page
      .getByTestId("current-section-script")
      .locator("p")
      .filter({ hasText: new RegExp(`^Hey Prepared${profile}\\?\\s*$`) });
    const introduction = page
      .getByTestId("current-section-script")
      .locator("p")
      .filter({
        hasText: new RegExp(
          `^Hey Prepared${profile}, this is Spoken Representative!\\s*$`,
        ),
      });
    await expect(greeting).toHaveCount(1);
    await expect(introduction).toHaveCount(1);
    const greetingBox = await greeting.boundingBox(),
      introBox = await introduction.boundingBox();
    expect(introBox!.y).toBeGreaterThanOrEqual(
      greetingBox!.y + greetingBox!.height,
    );
    await expect(page.getByText("All openers", { exact: true })).toHaveCount(0);
    for (let section = 0; section < 26; section++) {
      await expect(
        page.getByText(`Section ${section + 1} of 26`, { exact: true }),
      ).toBeVisible();
      if (section < 25) await page.getByTestId("coach-next").click();
    }
    await expect(page.getByTestId("coach-next")).toBeDisabled();
    for (let section = 25; section > 0; section--) {
      await page.getByTestId("coach-back").click();
      await expect(
        page.getByText(`Section ${section} of 26`, { exact: true }),
      ).toBeVisible();
    }
    await expect(page.getByTestId("coach-back")).toBeDisabled();
    await expect(page.getByTestId("current-section-script")).toContainText(
      "I’m holding a copy of your tax records here",
    );
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { precallMatrixEvidence: { starts: number } })
            .precallMatrixEvidence.starts,
      ),
    ).toBe(1);
  });

for (const [width, height] of [
  [375, 740],
  [768, 800],
  [1280, 480],
  [1440, 900],
])
  test(`setup layout and keyboard at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.route("https://synthetic.local/**", serveMatrix);
    await page.goto("https://synthetic.local/");
    await page.evaluate(() =>
      localStorage.setItem(
        "sandra.softphone.coach.v1",
        JSON.stringify({ enabled: true, scriptId: "closr-outbound" }),
      ),
    );
    await page.addScriptTag({ content: harnessBundle });
    await page.getByTestId("profile-0").click();
    await expect(page.getByTestId("precall-setup")).not.toContainText(
      "Loading…",
    );
    for (const group of [
      "Call basics",
      "Seller’s situation",
      "Offer details",
      "Script branches",
    ]) {
      const trigger = page.getByRole("button", {
        name: new RegExp(`^${group}`),
      });
      if ((await trigger.getAttribute("aria-expanded")) === "false")
        await trigger.click();
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      expect(
        await page
          .getByTestId("precall-setup")
          .evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
      ).toBe(true);
      const pinnedCall = await page
        .getByTestId("dialer-call-manual")
        .boundingBox();
      expect(pinnedCall!.y).toBeGreaterThanOrEqual(0);
      expect(pinnedCall!.y + pinnedCall!.height).toBeLessThanOrEqual(height);
      await page.screenshot({
        path: `tmp/precall-matrix-preview/layout-${width}-${group.replaceAll(" ", "-")}.png`,
      });
    }
    const discovery = page.getByRole("combobox", {
      name: "Discovery questions",
      exact: true,
    });
    await discovery.focus();
    await discovery.press("ArrowDown");
    await expect(
      page.getByRole("option", { name: "Investor", exact: true }),
    ).toBeVisible();
    await discovery.press("Escape");
    await expect(discovery).toBeFocused();
    const basics = page.getByRole("button", { name: /^Call basics/ });
    await basics.click();
    const name = page.getByTestId("setup-field-seller_name");
    await name.fill("Zoë 王 — long homeowner name ".repeat(8));
    await name.press("End");
    await name.press("a");
    await expect(name).toBeFocused();
    await name.press("Tab");
    await expect(page.getByTestId("setup-field-rep_name")).toBeFocused();
    const call = page.getByTestId("dialer-call-manual");
    await call.scrollIntoViewIfNeeded();
    const box = await call.boundingBox();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(height);
    await expect(call).toBeEnabled();
  });

test("delayed A-B-A reads and failed retry cannot overwrite explicit edits", async ({
  page,
}) => {
  await page.route("https://synthetic.local/**", serveMatrix);
  await page.goto("https://synthetic.local/");
  await page.evaluate(() =>
    localStorage.setItem(
      "sandra.softphone.coach.v1",
      JSON.stringify({ enabled: true, scriptId: "closr-outbound" }),
    ),
  );
  await page.addScriptTag({ content: harnessBundle });
  await page.getByTestId("profile-0").click();
  await expect(page.getByTestId("precall-setup")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await page.getByRole("button", { name: /^Call basics/ }).click();
  await page.getByTestId("setup-field-seller_name").fill("Retain homeowner A");
  await page.evaluate(() =>
    (
      window as unknown as {
        precallMatrixFaults: { setContextMode: (m: string) => void };
      }
    ).precallMatrixFaults.setContextMode("deferred"),
  );
  await page.getByRole("button", { name: "Close dialer", exact: true }).click();
  await page.getByTestId("profile-1").click();
  await expect(page.getByTestId("precall-setup")).toHaveAttribute(
    "aria-busy",
    "true",
  );
  await page.getByRole("button", { name: "Close dialer", exact: true }).click();
  await page.getByTestId("profile-0").click();
  await expect(page.getByTestId("precall-setup")).toHaveAttribute(
    "data-target-key",
    "lead:00000000-0000-4000-8000-00000000A100",
  );
  await expect(page.getByTestId("dialer-call-manual")).toBeEnabled();
  await page.evaluate(() =>
    (
      window as unknown as {
        precallMatrixFaults: { resolveNewest: () => void };
      }
    ).precallMatrixFaults.resolveNewest(),
  );
  await expect(page.getByTestId("precall-setup")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  const basics = page.getByRole("button", { name: /^Call basics/ });
  if ((await basics.getAttribute("aria-expanded")) === "false")
    await basics.click();
  await expect(page.getByTestId("setup-field-seller_name")).toHaveValue(
    "Retain homeowner A",
  );
  await page.evaluate(() =>
    (
      window as unknown as {
        precallMatrixFaults: { resolveRemaining: () => void };
      }
    ).precallMatrixFaults.resolveRemaining(),
  );
  await expect(page.getByTestId("setup-field-seller_name")).toHaveValue(
    "Retain homeowner A",
  );
  await page.evaluate(() =>
    (
      window as unknown as {
        precallMatrixFaults: { setContextMode: (m: string) => void };
      }
    ).precallMatrixFaults.setContextMode("failed"),
  );
  await page.getByRole("switch", { name: "Enable live coach" }).click();
  await page.getByRole("switch", { name: "Enable live coach" }).click();
  await expect(
    page.getByText("Could not load call details. You can still call.", {
      exact: false,
    }),
  ).toBeVisible();
  const reopened = page.getByRole("button", { name: /^Call basics/ });
  if ((await reopened.getAttribute("aria-expanded")) === "false")
    await reopened.click();
  await expect(page.getByTestId("setup-field-seller_name")).toHaveValue(
    "Retain homeowner A",
  );
  await page.getByTestId("dialer-call-manual").click();
  await expect(page.getByTestId("coach-live-view")).toBeVisible();
  await expect(page.getByTestId("current-section-script")).toContainText(
    "Hey Retain?",
  );
});

test("setup text and empty-field hints meet 4.5:1 in all groups", async ({
  page,
}) => {
  await page.route("https://synthetic.local/**", serveMatrix);
  await page.goto("https://synthetic.local/");
  await page.evaluate(() =>
    localStorage.setItem(
      "sandra.softphone.coach.v1",
      JSON.stringify({ enabled: true, scriptId: "closr-outbound" }),
    ),
  );
  await page.addScriptTag({ content: harnessBundle });
  await page.getByTestId("profile-1").click();
  await expect(page.getByTestId("precall-setup")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  let checked = 0;
  for (const group of [
    "Call basics",
    "Seller’s situation",
    "Offer details",
    "Script branches",
  ]) {
    const trigger = page.getByRole("button", { name: new RegExp(`^${group}`) });
    if ((await trigger.getAttribute("aria-expanded")) === "false")
      await trigger.click();
    const pairs = await page.getByTestId("precall-setup").evaluate((root) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext("2d")!;
      const rgb = (color: string) => {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 1, 1);
        return [...ctx.getImageData(0, 0, 1, 1).data];
      };
      const lum = (rgba: number[]) =>
        rgba
          .slice(0, 3)
          .map((v) => v / 255)
          .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
          .reduce((n, v, i) => n + v * [0.2126, 0.7152, 0.0722][i], 0);
      const nodes = [...root.querySelectorAll<HTMLElement>("*")].filter(
        (e) =>
          e.getClientRects().length &&
          (e instanceof HTMLInputElement ||
            [...e.childNodes].some(
              (n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim(),
            )),
      );
      return nodes.map((e) => {
        let parent: Element | null = e,
          bg = [255, 255, 255, 255];
        while (parent) {
          const color = rgb(getComputedStyle(parent).backgroundColor);
          if (color[3] === 255) {
            bg = color;
            break;
          }
          parent = parent.parentElement;
        }
        const isEmpty = e instanceof HTMLInputElement && !e.value;
        const fg = rgb(
            getComputedStyle(e, isEmpty ? "::placeholder" : null).color,
          ),
          a = lum(fg),
          b = lum(bg);
        return {
          label: e.getAttribute("data-testid") || e.textContent?.trim(),
          ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
        };
      });
    });
    for (const pair of pairs) {
      expect(pair.ratio, `${group}: ${pair.label}`).toBeGreaterThanOrEqual(4.5);
      checked++;
    }
  }
  expect(checked).toBeGreaterThan(40);
});
