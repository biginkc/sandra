import { readFileSync } from "node:fs";
import path from "node:path";
import * as esbuild from "esbuild";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";

export async function buildSearchOverlayFixture() {
  const root = process.cwd();
  const stub = path.join(root, "e2e/fixtures/search-redesign/stubs.ts");
  const aliases = Object.fromEntries([
    "@/lib/dialer/actions", "@/lib/dialer/jitter-actions", "@/lib/dialer/transport-selection", "@/lib/dialer/dtmf-tone", "@/lib/coach/use-coach-session", "@/lib/coach/flags", "@/components/coach/keyed-coach-live-view",
  ].map(name => [name, stub]));
  const bundle = await esbuild.build({ entryPoints: [path.join(root, "e2e/fixtures/search-redesign/harness.tsx")], bundle: true, platform: "browser", format: "iife", target: "chrome120", jsx: "automatic", write: false, outdir: "out", alias: { ...aliases, "@": path.join(root, "src"), "next/navigation": path.join(root, "e2e/fixtures/search-redesign/navigation.ts") }, define: { "process.env.NODE_ENV": '"test"' } });
  const globalPath = path.join(root, "src/app/globals.css");
  const css = await postcss([tailwindcss()]).process(readFileSync(globalPath, "utf8"), { from: globalPath });
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css.css}\n${bundle.outputFiles.find(file => file.path.endsWith(".css"))!.text}</style></head><body><div id="root"></div><script>${bundle.outputFiles.find(file => file.path.endsWith(".js"))!.text.replaceAll("</script", "<\\/script")}</script></body></html>`;
}
