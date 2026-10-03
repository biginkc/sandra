import { expect, test } from "@playwright/test";
import * as esbuild from "esbuild";
import path from "node:path";

let bundle = "";
test.beforeAll(async () => {
  const backend = "window.__dripBackend";
  const modules: Record<string, string> = {
    "navigation": `export const useRouter=()=>({refresh:()=>${backend}.refresh(),push(){}});`,
    "link": "export default function Link({children,...props}) { return <a {...props}>{children}</a>; }",
    "dispo": `export const setInboxDispoAndStartDrip=(...args)=>${backend}.startWithOutcome(...args); export const setOutreachDispo=async()=>({ok:true}); export const moveMessageThreadToLead=async()=>({ok:true});`,
    "sequences": `export const listDripChoices=async()=>({ok:true,data:[{id:'synthetic-drip',name:'Confirmed owner',textCount:11,days:30,firstSend:'Tomorrow'}]}); export const startDripForLeads=(...args)=>${backend}.startDirect(...args); export const changeDripAction=async()=>({ok:false,error:{message:'Unexpected switch'}}); export const cancelEnrollment=async()=>({ok:true}); export const pauseEnrollmentAction=cancelEnrollment; export const resumeEnrollmentAction=cancelEnrollment; export const retrySequenceStepAction=cancelEnrollment;`,
    "progress": `export const listDripProgress=async()=>${backend}.state.progress?[${backend}.state.progress]:[];`,
    "supabase": "export const createClient=()=>({});",
    "appointments": "export const BookAppointmentPopover=()=>null;",
    "call-action": "export const callAction=(promise)=>promise;",
  };
  const result = await esbuild.build({
    entryPoints: [path.resolve("e2e/synthetic/fixtures/lead-drip-parity-harness.tsx")],
    bundle: true, platform: "browser", format: "iife", target: "chrome120", jsx: "automatic",
    define: { "process.env.NODE_ENV": '\"test\"' }, write: false,
    plugins: [{ name: "offline-drip-boundaries", setup(build) {
      const bind = (filter: RegExp, key: string) => build.onResolve({ filter }, () => ({path:key, namespace:"offline"}));
      bind(/^next\/navigation$/, "navigation"); bind(/^next\/link$/, "link");
      bind(/messages\/dispo-actions$/, "dispo"); bind(/sequences\/actions$/, "sequences");
      bind(/sequences\/drip-progress$/, "progress"); bind(/supabase\/client$/, "supabase");
      bind(/book-appointment-popover$/, "appointments"); bind(/errors\/call-action$/, "call-action");
      build.onLoad({filter:/.*/, namespace:"offline"}, (args) => ({contents:modules[args.path],loader:"tsx",resolveDir:process.cwd()}));
    }}],
  });
  bundle = result.outputFiles[0].text;
});

for (const surface of ["top", "rail"] as const) {
  for (const scenario of ["success", "partial", "dnc"] as const) {
    test(`${surface} drip start from Nurture: ${scenario}`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      // Intercept every request: fixtures cannot reach production or any provider.
      await page.route("**/*", (route) => route.fulfill({status:200,contentType:"text/html",body:'<div id="root"></div>'}));
      await page.goto(`https://synthetic.invalid/lead?case=${scenario}`);
      await page.addScriptTag({content:bundle});
      await expect(page.getByTestId("server-outcome")).toHaveText("nurture");
      await expect(page.getByRole("button", {name:"Start drip", exact:true})).toBeVisible();
      await page.locator(surface === "rail" ? '[data-testid="lead-drip-card"]' : '[data-testid="dispo-needs-sequence"]').getByRole("button", {name:surface === "rail" ? "Start drip" : "Needs drip",exact:true}).click();
      await page.getByRole("button", {name:/Confirmed owner.*11 texts/}).click();
      if (scenario === "success") {
        await expect(page.getByTestId("lead-drip-card")).toContainText("Confirmed owner");
        await expect(page.getByRole("button", {name:"Switch drip",exact:true})).toBeVisible();
        await expect(page.getByTestId("server-outcome")).toHaveText("needs_sequence");
        await expect(page.locator('[data-testid="dispo-needs-sequence"]')).toContainText("Needs drip");
        // Server refresh supplies the top bar's active-drip guard too.
        await page.getByTestId("dispo-needs-sequence").getByRole("button", {name:"Needs drip",exact:true}).click();
        await page.getByRole("button", {name:/Confirmed owner.*11 texts/}).click();
        await expect(page.getByTestId("drip-cant-start")).toContainText("Already in Confirmed owner");
      } else if (scenario === "partial") {
        await expect(page.getByTestId("server-outcome")).toHaveText("needs_sequence");
        await expect(page.getByText(/Synthetic enrollment failure/).first()).toBeVisible();
        await expect(page.getByRole("button", {name:"Start drip",exact:true})).toBeVisible();
      } else {
        await expect(page.getByTestId("server-outcome")).toHaveText("nurture");
        await expect(page.getByText(/This lead is do not contact or opted out/).first()).toBeVisible();
      }
      expect(await page.evaluate(() => {
        const state = (window as unknown as {__dripBackend:{state:{guardedStarts:number;directStarts:number}}}).__dripBackend.state;
        return {guardedStarts:state.guardedStarts,directStarts:state.directStarts};
      })).toEqual({guardedStarts:scenario === "success" ? 2 : 1,directStarts:0});
      expect(errors).toEqual([]);
    });
  }
}
