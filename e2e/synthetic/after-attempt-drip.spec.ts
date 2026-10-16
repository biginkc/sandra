import { expect, test } from "@playwright/test";
import * as esbuild from "esbuild";
import path from "node:path";
let bundle = "";
test.beforeAll(async () => {
  const result = await esbuild.build({
    entryPoints: [path.resolve("e2e/synthetic/fixtures/after-attempt-drip-harness.tsx")],
    bundle:true, platform:"browser", format:"iife", target:"chrome120", jsx:"automatic", write:false,
    define:{"process.env.NODE_ENV":'"test"'},
    plugins:[{name:"offline",setup(build) {
      build.onResolve({filter:/sequences\/actions$/},()=>({path:"actions",namespace:"offline"}));
      build.onResolve({filter:/sequences\/drip-progress$/},()=>({path:"progress",namespace:"offline"}));
      build.onResolve({filter:/supabase\/client$/},()=>({path:"client",namespace:"offline"}));
      build.onLoad({filter:/.*/,namespace:"offline"}, args => ({loader:"js",contents: args.path === "client" ? 'export const createClient=()=>({});' : args.path === "progress" ? 'export const listDripProgress=async()=>window.dripProgress;' : `
        export const listDripChoices=async()=>({ok:true,data:Array.from({length:30},(_,i)=>({id:String(i),name:'Drip '+i,textCount:4,days:60,firstSend:'Tomorrow'}))});
        export const changeDripAction=async(enrollment,id)=>{window.switchCalls.push([enrollment,id]);window.dripProgress=[];return {ok:true,data:{status:'failed',reason:'Previous drip stopped. Synthetic blocked enrollment.'}}};
        export const startDripForLeads=async()=>({ok:true,data:{results:[{status:'failed',reason:'Synthetic start rejected.'}]}});
      `}));
    }}],
  }); bundle = result.outputFiles[0].text;
});
for (const status of ["active","paused"]) test(`explicit ${status} replacement keeps failure visible in a long list`, async ({page}) => {
  await page.setViewportSize({width:390,height:480});
  await page.route("**/*",route=>route.fulfill({contentType:"text/html",body:'<div id="root"></div><style>.overflow-y-auto{overflow-y:auto}button{min-height:44px;display:block}span{display:block}</style>'}));
  await page.goto("https://synthetic.invalid");
  await page.evaluate(status => Object.assign(window,{switchCalls:[],dripProgress:[{enrollmentId:"old-enrollment",sequenceId:"old",sequenceName:"Talking price",enrollmentStatus:status}]}),status);
  await page.addScriptTag({content:bundle});
  await expect(page.getByText(/Current drip:/)).toContainText(`Talking price (${status})`);
  await page.getByRole("button",{name:/^Drip 29 /}).click();
  expect(await page.evaluate(()=> (window as unknown as {switchCalls:unknown[]}).switchCalls)).toEqual([]);
  await page.getByRole("button",{name:"Switch to selected drip"}).click();
  const error=page.getByRole("alert");
  await expect(error).toContainText("Previous drip stopped");
  await expect(error).toBeFocused();
  await expect(error).toBeInViewport({ratio:1});
  await expect(page.getByText("Not currently in an active or paused drip.")).toBeVisible();
  expect(await page.evaluate(()=> (window as unknown as {switchCalls:unknown[]}).switchCalls)).toEqual([["old-enrollment","29"]]);
  // Retry without an enrollment uses the ordinary guarded start, with its error above the list.
  await page.getByRole("button",{name:/^Drip 29 /}).click();
  const startError=page.getByRole("status");
  await expect(startError).toContainText("Synthetic start rejected");
  await expect(startError).toBeFocused();
  await expect(startError).toBeInViewport({ratio:1});
});
