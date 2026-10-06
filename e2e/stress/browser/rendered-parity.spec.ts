import { quickPickDueAt } from "../../../src/lib/my-leads/quick-picks";
import { asRep } from "../db";
import { expectedSectionCounts, sectionParityProblems, stripParityProblems } from "../parity";
import { expect, test } from "./fixtures";
import { recordResult, signIn, type Run } from "./support";

/**
 * Oracle 16, rendered parity: after a reload, the strip rows, section counts and the lead page's
 * next step show the same ids and times as the database rows. Runs after the chaos ticks.
 */
let run!: Run; // from the `run` fixture (needs the verified app-egress proof)

test("stress rendered parity: lead page next step matches the open appointment row (after reload)", async ({ page, context, run: fixtureRun }) => {
  run = fixtureRun;
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

  // Strip membership and section counts, rendered on the My Leads page after a reload, against the same rows in the database.
  await page.goto("/my-leads");
  await page.reload();
  await page.getByTestId("call-next-strip").waitFor({ timeout: 30_000 }).catch(() => {});
  const renderedStrip = await page.locator('[data-testid^="call-next-row-"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-property-id") ?? ""));
  const dbStrip = await asRep(run.db, run.world.repUserId, (c) => c.query<{ v: { rows: Array<{ propertyId: string }> } }>("select public.fn_get_my_leads_call_next($1,$2,25) as v", [run.cfg.orgId, run.world.repUserId]));
  failures.push(...stripParityProblems(renderedStrip, dbStrip.rows[0]!.v.rows.map((r) => r.propertyId)));
  const sections = await page.locator('[data-testid^="my-leads-section-"]').evaluateAll((els) => els.map((e) => ({ stage: (e.getAttribute("data-testid") ?? "").replace("my-leads-section-", ""), badge: e.querySelector('[aria-label$="lead"], [aria-label$="leads"]')?.getAttribute("aria-label") ?? "" })));
  // The rep must own ONLY run leads, or the comparison would be apples to oranges: refuse instead of narrowing the query.
  const foreign = (await run.db.query<{ n: number }>("select count(*)::int n from public.properties p where p.org_id=$1 and p.assigned_user_id=$2 and p.deleted_at is null and p.address not like $3 || '%'", [run.cfg.orgId, run.world.repUserId, run.cfg.runTag])).rows[0]!.n;
  if (foreign > 0) failures.push(`the rep owns ${foreign} lead(s) that are not run leads: section counts cannot be compared`);
  const dbRows = (await run.db.query<{ stage: string; in_drip: boolean; n: number }>(
    `select coalesce(qs.stage, 'not_contacted') as stage,
            exists (select 1 from public.sequence_enrollments e where e.property_id=p.id and e.org_id=p.org_id and e.status='active') as in_drip,
            count(*)::int n
       from public.properties p
       left join public.acquisition_queue_states qs on qs.property_id=p.id and qs.org_id=p.org_id
      where p.org_id=$1 and p.assigned_user_id=$2 and p.deleted_at is null and (qs.property_id is null or qs.archived_at is null)
      group by 1, 2`, [run.cfg.orgId, run.world.repUserId])).rows;
  const { expected, problems: unknownStages } = expectedSectionCounts(dbRows);
  failures.push(...unknownStages, ...sectionParityProblems(sections, expected));
  recordResult(run.dir, -16, failures.length === 0, failures.slice(0, 5).join(" | "));
  expect(failures).toEqual([]);
});

