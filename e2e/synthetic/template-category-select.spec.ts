import { expect, test } from "@playwright/test";
import * as esbuild from "esbuild";
import path from "node:path";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";

let script = "";
let css = "";
test.beforeAll(async () => {
  css = (
    await postcss([tailwindcss()]).process('@import "tailwindcss";', {
      from: path.resolve("src/app/globals.css"),
    })
  ).css;
  const result = await esbuild.build({
    stdin: {
      contents: `import React from "react";
        import { createRoot } from "react-dom/client";
        import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
        function Harness() {
          const [selected, setSelected] = React.useState("Probate");
          return <><Select value={selected} onValueChange={setSelected}>
            <SelectTrigger aria-label="Category"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">All categories</SelectItem>
              <SelectItem value="Probate">Probate</SelectItem>
              <SelectItem value="Vacant">Vacant</SelectItem></SelectContent>
          </Select><output data-testid="selection">{selected}</output></>;
        }
        createRoot(document.getElementById("root")).render(<Harness />);`,
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    alias: { "@": path.resolve("src") },
    define: { "process.env.NODE_ENV": '"test"' },
    write: false,
    logLevel: "silent",
  });
  script = result.outputFiles[0].text;
});

test("the real category Select clears an existing category through a mouse click", async ({
  page,
}) => {
  await page.setContent(
    `<style>${css}</style><main style="padding:80px;width:400px"><div id="root"></div></main>`,
  );
  await page.addScriptTag({ content: script });
  await expect(page.getByTestId("selection")).toHaveText("Probate");
  await page.getByRole("combobox", { name: "Category" }).click();
  await page
    .getByRole("option", { name: "All categories", exact: true })
    .click();
  await expect(page.getByTestId("selection")).toHaveText("all");
  await page.getByRole("combobox", { name: "Category" }).click();
  await page.getByRole("option", { name: "Probate", exact: true }).click();
  await expect(page.getByTestId("selection")).toHaveText("Probate");
});
