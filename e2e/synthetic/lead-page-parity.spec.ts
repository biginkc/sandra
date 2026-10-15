import { expect, test } from "@playwright/test";
import * as esbuild from "esbuild";
import path from "node:path";

let bundle = "";
test.beforeAll(async () => {
  const stubs: Record<string, string> = {
    navigation: "export const useRouter=()=>({refresh(){},push(){}});",
    lifecycle: "const ok=async()=>({ok:true,data:{}}); export const completeAppointmentAction=ok; export const cancelAppointmentAction=ok;",
    tasks: "const ok=async()=>({ok:true,data:{}}); export const completeTaskAction=ok; export const snoozeTaskAction=ok;",
    popover: "export const BookAppointmentPopover=()=>null;",
    acquisition: "export const loadLeadAcquisitionHistory=async()=>({ok:false,message:'offline'});",
    history: "export const loadLeadAppointmentHistory=(...a)=>window.__leadPage.loadHistory(...a);",
  };
  const result = await esbuild.build({
    entryPoints: [path.resolve("e2e/synthetic/fixtures/lead-page-parity-harness.tsx")],
    bundle: true, platform: "browser", format: "iife", target: "chrome120", jsx: "automatic", write: false,
    alias: { "@": path.resolve("src") },
    define: { "process.env.NODE_ENV": '"test"', "process.env": "{}" },
    plugins: [{ name: "offline-boundaries", setup(build) {
      const bind = (filter: RegExp, key: string) => build.onResolve({ filter }, () => ({ path: key, namespace: "offline" }));
      bind(/^next\/navigation$/, "navigation");
      bind(/lifecycle-actions$/, "lifecycle");
      bind(/tasks\/actions$/, "tasks");
      bind(/book-appointment-popover$/, "popover");
      bind(/lead-appointments-actions$/, "history");
      bind(/acquisition-history-actions$/, "acquisition");
      build.onLoad({ filter: /.*/, namespace: "offline" }, (args) => ({ contents: stubs[args.path], loader: "tsx", resolveDir: process.cwd() }));
    } }],
  });
  bundle = result.outputFiles[0].text;
});

async function open(page: import("@playwright/test").Page, query = "") {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => route.fulfill({ status: 200, contentType: "text/html", body: '<div id="root"></div>' }));
  await page.goto(`https://synthetic.invalid/lead${query}`);
  await page.addScriptTag({ content: bundle });
  return errors;
}

test("lead page lists snoozed, past-due, multiple callbacks and paged history with the right controls", async ({ page }) => {
  const errors = await open(page);
  const upcoming = page.getByTestId("lead-appointments-upcoming");
  const pastDue = page.getByTestId("lead-appointments-past-due");
  const history = page.getByTestId("lead-appointments-history");

  await expect(upcoming.getByRole("listitem")).toHaveCount(5);
  await expect(upcoming).toContainText("Snoozed walkthrough");
  await expect(upcoming).toContainText("Snoozed callback");
  await expect(upcoming.locator('[data-task-type="callback"]')).toHaveCount(3);
  await expect(pastDue.getByRole("listitem")).toHaveCount(1);
  await expect(pastDue).toContainText("Missed walkthrough");

  // Past-due appointment: outcome buttons. Callback: Done/Snooze only.
  await expect(pastDue.getByRole("button", { name: /held/i })).toBeVisible();
  await expect(pastDue.getByRole("button", { name: /no.?show/i })).toBeVisible();
  const callback = page.getByTestId("lead-appointment-Callback tomorrow");
  await expect(callback.getByRole("button", { name: /done/i })).toBeVisible();
  await expect(callback.getByRole("button", { name: /held/i })).toHaveCount(0);

  // History pages 20 at a time.
  await expect(history.getByRole("listitem")).toHaveCount(20);
  await history.getByRole("button", { name: "Load more history" }).click();
  await expect(history.getByRole("listitem")).toHaveCount(25);
  await expect(history.getByRole("button", { name: "Load more history" })).toHaveCount(0);
  await expect(history.getByRole("button")).toHaveCount(0);

  // Episodes and per-attempt follow-up.
  await expect(page.getByTestId("lead-assignment-episodes")).toContainText("Assigned to Ana");
  await expect(page.getByTestId("lead-assignment-episodes")).toContainText("Initialized for Ben (ended)");
  const followUp = page.getByTestId("attempt-follow-up-att-1");
  await expect(followUp).toContainText("Text follow-up: Blocked");
  await expect(followUp).toContainText("Blocked reason: sms_opt_out");
  expect(errors).toEqual([]);
});

test("another rep sees the schedule but no lifecycle controls; an owner sees them", async ({ page }) => {
  await open(page, "?viewer=rep-2");
  await expect(page.getByTestId("lead-appointments-upcoming").getByRole("listitem")).toHaveCount(5);
  await expect(page.getByTestId("lead-appointments-past-due").getByRole("button")).toHaveCount(0);
  await expect(page.getByTestId("lead-appointments-upcoming").getByRole("button")).toHaveCount(0);

  const owner = await page.context().newPage();
  await open(owner, "?viewer=boss&owner=1");
  await expect(owner.getByTestId("lead-appointments-past-due").getByRole("button", { name: /held/i })).toBeVisible();
});
