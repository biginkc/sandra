// Compile the actual component classes and tokens, then measure browser-computed colors.
// Active actions require 4.5:1; disabled actions retain the existing opacity treatment.
import { compile } from "@tailwindcss/node";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const button = readFileSync("src/components/ui/button.tsx", "utf8");
const hero = readFileSync(
  "src/app/(dashboard)/leads/[id]/lead-media-hero.tsx",
  "utf8",
);
const base = button.match(/"(group\/button[^"\n]+)"/)[1];
const outline = button.match(/outline:\s*"([^"]+)"/)[1];
const rows = [
  ...hero.matchAll(/className=\{`([^`]+)\$\{actionFocusClasses\}`\}/g),
].map((m) => m[1]);
const focus = hero.match(/const actionFocusClasses =\s*"([^"]+)"/)[1];
assert.equal(rows.length, 2, "Expected flat and media hero action layouts");
const cssInput = readFileSync("src/app/globals.css", "utf8");
const classes = [
  base,
  outline,
  focus,
  ...rows,
  "bg-card",
  "text-white",
  "bg-slate-950",
]
  .join(" ")
  .split(/\s+/);
const compiler = await compile(cssInput, {
  base: `${process.cwd()}/src/app`,
  onDependency: () => {},
});
const css = compiler.build(classes);
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHANNEL
    ? { channel: process.env.PLAYWRIGHT_CHANNEL }
    : {}),
});
const page = await browser.newPage();
const results = [];
const normalBackgrounds = new Map();
try {
  for (const theme of ["light", "dark"])
    for (let layout = 0; layout < 2; layout++) {
      await page.setContent(
        `<style>${css} *{transition:none!important}</style><main class="${theme === "dark" ? "dark" : ""}"><section style="background:${layout ? "#020617" : "var(--card)"};color:${layout ? "white" : "var(--foreground)"}"><div class="${rows[layout]} ${focus}"><button id="b" class="${base} ${outline}">Send SMS</button><a id="a" href="#" class="${base} ${outline}">Open in My Leads</a><button id="d" disabled class="${base} ${outline}">Disabled action</button></div></section></main>`,
      );
      for (const id of ["b", "a", "d"])
        for (const state of id === "d"
          ? ["disabled"]
          : ["normal", "hover", "focus", "expanded"]) {
          await page.mouse.move(0, 0);
          await page.evaluate(() => document.activeElement?.blur());
          if (state === "hover") await page.locator("#" + id).hover();
          if (state === "expanded")
            await page
              .locator("#" + id)
              .evaluate((el) => el.setAttribute("aria-expanded", "true"));
          if (state === "focus") {
            await page.keyboard.press("Tab");
            await page.locator("#" + id).focus();
          }
          const result = await page.locator("#" + id).evaluate((el) => {
            const s = getComputedStyle(el);
            if (
              document.querySelector(`#${el.id}:hover`) === el &&
              !matchMedia("(hover: hover)").matches
            )
              throw new Error("Hover styles unavailable");
            const parse = (x) => {
              const c = document.createElement("canvas");
              c.width = c.height = 1;
              const ctx = c.getContext("2d");
              if (!CSS.supports("color", x))
                throw new Error(`Invalid computed color: ${x}`);
              ctx.fillStyle = "#010203";
              ctx.fillStyle = x;
              const first = ctx.fillStyle;
              ctx.fillStyle = "#040506";
              ctx.fillStyle = x;
              if (first !== ctx.fillStyle)
                throw new Error(`Canvas rejected computed color: ${x}`);
              ctx.fillRect(0, 0, 1, 1);
              const v = [...ctx.getImageData(0, 0, 1, 1).data];
              return [...v.slice(0, 3), v[3] / 255];
            };
            const blend = (f, b) =>
              f
                .slice(0, 3)
                .map((v, i) => v * (f[3] ?? 1) + b[i] * (1 - (f[3] ?? 1)));
            const parents = [];
            for (let p = el.parentElement; p; p = p.parentElement)
              parents.unshift(parse(getComputedStyle(p).backgroundColor));
            let bg = [255, 255, 255];
            for (const p of parents) bg = blend(p, bg);
            const parent = bg;
            bg = blend(parse(s.backgroundColor), bg);
            let fg = parse(s.color);
            const opacity = Number(s.opacity);
            fg = blend(fg, bg);
            fg = blend([...fg, opacity], parent);
            bg = blend([...bg, opacity], parent);
            const lum = (c) =>
              c
                .map((v) => v / 255)
                .map((v) =>
                  v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4,
                )
                .reduce((n, v, i) => n + v * [0.2126, 0.7152, 0.0722][i], 0);
            let l = [lum(fg), lum(bg)].sort((a, b) => b - a);
            return {
              hovered: document.querySelector(`#${el.id}:hover`) === el,
              focused: el === document.activeElement,
              focusVisible:
                document.querySelector(`#${el.id}:focus-visible`) === el,
              hoverCapable: matchMedia("(hover: hover)").matches,
              color: s.color,
              background: s.backgroundColor,
              opacity,
              ratio: (l[0] + 0.05) / (l[1] + 0.05),
            };
          });
          await page
            .locator("#" + id)
            .evaluate((el) => el.removeAttribute("aria-expanded"));
          const key = `${theme}:${layout}:${id}`;
          if (state === "normal") normalBackgrounds.set(key, result.background);
          if (state === "hover") {
            assert(
              result.hoverCapable && result.hovered,
              `Hover not active: ${key}`,
            );
            assert.notEqual(
              result.background,
              normalBackgrounds.get(key),
              "Hover must change the background",
            );
          }
          if (state === "focus")
            assert(
              result.focused && result.focusVisible,
              `Keyboard focus not active: ${key}`,
            );
          results.push({
            theme,
            layout: layout ? "media" : "flat",
            id,
            state,
            ...result,
          });
          if (result.ratio < (state === "disabled" ? 3 : 4.5))
            throw new Error(JSON.stringify(results.at(-1)));
        }
    }
  console.log(JSON.stringify(results, null, 2));
  console.log(
    `${results.length} computed contrast checks passed; minimum ${Math.min(...results.map((r) => r.ratio)).toFixed(2)}:1`,
  );
} finally {
  await browser.close();
}
