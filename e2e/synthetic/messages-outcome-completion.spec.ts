import { expect, test } from "@playwright/test";
import * as esbuild from "esbuild";
import path from "node:path";

let bundle = "";
test.beforeAll(async () => {
  const modules: Record<string, string> = {
    navigation: `export const useRouter=()=>({refresh(){window.__refreshes=(window.__refreshes||0)+1},push(url){location.href=url}});`,
    link: `export default function Link({children,...props}){return <a {...props}>{children}</a>}`,
    dispo: `const save=()=>new Promise(resolve=>{window.__completeAction=()=>resolve(new URLSearchParams(location.search).get('case')==='failure'?{ok:false,error:'Save failed'}:{ok:true,alreadyQualified:false})});export const setOutreachDispo=save;export const moveMessageThreadToLead=save;export const setInboxDispoAndStartDrip=async()=>({ok:true,enrollment:{status:'enrolled',reason:'Enrolled'}});`,
    sequences: `export const listDripChoices=async()=>({ok:true,data:[{id:'drip',name:'Follow-up drip',textCount:2,days:3,firstSend:'Tomorrow'}]});export const startDripForLeads=async()=>({ok:true,data:{results:[{status:'enrolled',reason:'Enrolled'}]}});export const changeDripAction=async()=>({ok:true,data:{status:'enrolled'}});`,
    appointments: `export const BookAppointmentPopover=()=>null;`,
  };
  const result = await esbuild.build({
    stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {Toaster} from 'sonner';import {OutcomeBar} from './src/components/leads/outcome-bar';createRoot(document.getElementById('root')).render(<><textarea aria-label="Reply draft" defaultValue="Keep this draft"/><OutcomeBar propertyId="fixture" contactId="contact" propertyAddress="123 Main St" initialDispo={null} propertyStatus="prospect" currentUserId="rep"/><Toaster position="top-right"/></>);`, resolveDir: process.cwd(), loader: "tsx" },
    bundle: true, platform: "browser", format: "iife", jsx: "automatic", write: false,
    alias: { "@": path.resolve("src") }, define: { "process.env.NODE_ENV": '"test"' },
    plugins: [{ name: "owned-outcome-fixture", setup(build) {
      const bind = (filter: RegExp, key: string) => build.onResolve({ filter }, () => ({ path: key, namespace: "fixture" }));
      bind(/^next\/navigation$/, "navigation"); bind(/^next\/link$/, "link");
      bind(/messages\/dispo-actions$/, "dispo"); bind(/sequences\/actions$/, "sequences");
      bind(/book-appointment-popover$/, "appointments");
      build.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({ contents: modules[args.path], loader: "tsx", resolveDir: process.cwd() }));
    }}],
  });
  bundle = result.outputFiles[0].text;
});

for (const scenario of ["success", "failure"] as const) {
  for (const action of ["message-move-to-lead", "dispo-follow-up"] as const) {
    test(`${action}: ${scenario} completion keeps Messages and identifies the property`, async ({ page }) => {
      await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }));
      const url = `https://synthetic.invalid/messages?thread=owned-thread&case=${scenario}`;
      await page.goto(url);
      await page.addScriptTag({ content: bundle });
      await page.getByTestId(action).click();
      await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);
      await page.evaluate(() => (window as unknown as { __completeAction: () => void }).__completeAction());
      const notification = page.locator('[data-sonner-toast]');
      await expect(notification).toContainText("123 Main St");
      await expect(notification).toContainText(scenario === "failure" ? "Save failed" : action === "message-move-to-lead" ? "Moved to lead" : "Saved: Follow up");
      await expect(page.locator('[data-sonner-toaster]')).toHaveAttribute("data-y-position", "top");
      await expect(page.locator('[data-sonner-toaster]')).toHaveAttribute("data-x-position", "right");
      await expect(page).toHaveURL(url);
      await expect(page.getByRole("textbox", { name: "Reply draft" })).toHaveValue("Keep this draft");
      if (scenario === "success" && action === "message-move-to-lead") await expect(page.getByTestId(action)).toBeDisabled();
      else await expect(page.getByTestId(action)).toBeEnabled();
    });
  }
}
