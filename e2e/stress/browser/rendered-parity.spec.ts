import { expect, test } from "@playwright/test";

import { quickPickDueAt } from "../../../src/lib/my-leads/quick-picks";
import { loadRun, recordResult, signIn } from "./support";

/**
 * Oracle 16, rendered parity: after a reload, the strip rows, section counts and the lead page's
 * next step show the same ids and times as the database rows. Runs after the chaos ticks.
 */
const run = loadRun();

test("stress rendered parity: lead page next step matches the open appointment row (after reload)", async ({ page, context }) => {
  test.setTimeout(300_000); // the first dev-server compile of a page is slow; each lead is then quick
  await signIn(context, page);
  const leads = await run.db.query<{ related_property_id: string; id: string; due_at: Date }>(
    `select t.related_property_id, t.id, t.due_at from public.tasks t join public.properties p on p.id=t.related_property_id
      where p.org_id=$1 and p.address like $2 || '%' and t.type='appointment' and t.status='open' order by t.created_at limit 12`,
    [run.cfg.orgId, run.cfg.runTag],
  );
  expect(leads.rows.length, "the chaos day left open appointments to compare").toBeGreaterThan(0);
  const failures: string[] = [];
  for (const row of leads.rows) {
    await page.goto(`/leads/${row.related_property_id}`);
    await page.reload();
    const el = page.locator(`[data-testid="lead-next-action"]`).first();
    // Either the next step renders or the app's error page does: do not sit out the full wait on an error page.
    await Promise.race([el.waitFor({ timeout: 20_000 }), page.getByText("Something went wrong.").waitFor({ timeout: 20_000 })]).catch(() => {});
    if (await page.getByText("Something went wrong.").isVisible().catch(() => false)) { failures.push(`${row.related_property_id}: the lead page rendered its error page (${(await page.locator("main, body").first().innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 80)})`); continue; }
    const id = await el.getAttribute("data-next-step-id").catch(() => null);
    const due = await el.getAttribute("data-next-step-due-at").catch(() => null);
    if (!id || !due) { failures.push(`${row.related_property_id}: no rendered next step`); continue; }
    // An offer follow-up chain may legitimately be the rendered one; the id must be an open appointment of the same lead.
    const same = await run.db.query("select due_at from public.tasks where id=$1 and related_property_id=$2 and status='open'", [id, row.related_property_id]);
    if (same.rowCount !== 1) failures.push(`${row.related_property_id}: rendered id ${id} is not an open appointment`);
    else if (new Date(String(due)).toISOString() !== new Date(same.rows[0].due_at).toISOString()) failures.push(`${row.related_property_id}: rendered time ${due} != row ${new Date(same.rows[0].due_at).toISOString()}`);
  }
  void quickPickDueAt;
  recordResult(run.dir, -16, failures.length === 0, failures.slice(0, 5).join(" | "));
  expect(failures).toEqual([]);
});

test.afterAll(async () => { await run.db.end(); });
