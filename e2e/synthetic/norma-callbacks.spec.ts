import {expect,test} from "@playwright/test";
import * as esbuild from "esbuild";
import path from "node:path";
test("an inbound callback requires explicit property confirmation",async({page})=>{
 const result=await esbuild.build({entryPoints:[path.resolve("e2e/synthetic/fixtures/norma-callbacks-harness.tsx")],bundle:true,platform:"browser",format:"iife",target:"chrome120",jsx:"automatic",define:{"process.env.NODE_ENV":'"test"'},write:false,plugins:[{name:"offline-boundaries",setup(build){
  build.onResolve({filter:/^next\/navigation$/},()=>({path:"navigation",namespace:"offline"}));
  build.onResolve({filter:/^\.\/actions$/},()=>({path:"actions",namespace:"offline"}));
  build.onLoad({filter:/.*/,namespace:"offline"},({path})=>({contents:path==="navigation"?"export const useRouter=()=>({refresh(){document.body.dataset.refreshed='yes'}})":"export const findCallbackLeads=async()=>({leads:[{id:'p1',address:'1 Fixture Lane'},{id:'p2',address:'2 Fixture Lane'}]});export const associateCallback=async(id,property)=>{document.body.dataset.associated=property;return {ok:true}};",loader:"js"}));
 }}]});
 // All browser requests stay synthetic; no database/provider route is reachable.
 await page.route("**/*",route=>route.fulfill({contentType:"text/html",body:'<div id="root"></div>'}));
 await page.goto("https://synthetic.invalid/callback");await page.addScriptTag({content:result.outputFiles[0].text});
 await page.getByLabel("Search lead address").fill("Fixture");await page.getByRole("button",{name:"Search leads"}).click();
 await expect(page.getByLabel("Confirmed property")).toBeVisible();await expect(page.getByRole("button",{name:"Associate confirmed property"})).toHaveCount(0);
 await expect(page.locator("body")).not.toHaveAttribute("data-associated");
 await page.getByLabel("Confirmed property").selectOption("p2");await page.getByRole("button",{name:"Associate confirmed property"}).click();
 await expect(page.locator("body")).toHaveAttribute("data-associated","p2");await expect(page.locator("body")).toHaveAttribute("data-refreshed","yes");
});
