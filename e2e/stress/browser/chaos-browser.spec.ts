import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";

import { awaitDialWindow, createAppointment, rescheduleAppointment, sendCallEvents } from "../actions";
import { expireIntent } from "../levers";
import type { Tick } from "../manifest";
import { newRecord, type TickRecord } from "../scenarios";
import { loadRun, recordResult, retryNonMutating, signIn } from "./support";

/**
 * Scripted browser chaos. One test per scheduled `browser` tick, in schedule order, no improvisation.
 * Primitives: double-click, two tabs on one lead, back/forward after save, setOffline, Slow-3G CDP,
 * and GATED RELOAD (hold a response at `response_sent`, reload, release; the real order lands in ordering.jsonl).
 * A mutating step is never repeated until its original request is resolved (response_sent gate released, or
 * the stub log shows the outcome). The oracle (engine) judges the database afterwards; these specs only
 * drive the UI and record whether the gestures completed.
 */

const run = loadRun();
const logLines: string[] = [];

async function slow3g(page: Page): Promise<() => Promise<void>> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 400, downloadThroughput: (500 * 1024) / 8, uploadThroughput: (500 * 1024) / 8 });
  return async () => { await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }); };
}

async function openCallScreen(page: Page, propertyId: string): Promise<void> {
  await page.goto(`/my-leads/call/${propertyId}`);
  await expect(page.getByTestId("call-screen")).toBeVisible({ timeout: 30_000 });
}

/** The intent the Call click just prepared (newest for the lead). */
async function latestIntent(propertyId: string): Promise<{ id: string; customData: string; status: string } | null> {
  const r = await run.db.query<{ id: string; custom_data: string; status: string }>("select id, custom_data, status from public.dialpad_call_intents where property_id=$1 order by prepared_at desc limit 1", [propertyId]);
  return r.rows[0] ? { id: r.rows[0].id, customData: r.rows[0].custom_data, status: r.rows[0].status } : null;
}

async function clickCallAndWaitIntent(page: Page, propertyId: string, doubleClick = false, notIntentId?: string): Promise<{ id: string; customData: string }> {
  const button = page.getByTestId(`call-button-${propertyId}`);
  await expect(button).toBeEnabled();
  if (doubleClick) await button.dblclick(); else await button.click();
  await expect.poll(async () => { const it = await latestIntent(propertyId); return it && it.id !== notIntentId ? it.status : undefined; }, { timeout: 30_000 }).toBe("prepared");
  const it = (await latestIntent(propertyId))!;
  return { id: it.id, customData: it.customData };
}

/** The rest of a call: signed provider events to the app (what Dialpad would send), then the prompt auto-opens. */
async function finishCallViaEvents(propertyId: string, tick: Tick, customData: string): Promise<string> {
  const lead = run.world.leads.find((l) => l.propertyId === propertyId)!;
  const callId = `8${String(run.cfg.seed % 1e10).padStart(10, "0")}${String(tick.tick).padStart(3, "0")}9`;
  await sendCallEvents(run.ctx, lead, { callId, customData });
  return callId;
}

/** The auto-prompt for the call that just ended lives on the My Leads queue page ("How did the call go?"), bound to the webhook attempt. */
async function openAutoPrompt(page: Page, lead: { address: string }): Promise<Locator> {
  // The queue can hold several pending prompts; the one for THIS lead is identified by its address.
  const prompt = page.getByTestId("post-call-prompt").filter({ hasText: lead.address }).first();
  // Non-mutating: the queue reads its pending prompts when it loads, a few seconds after the call state settles. Reload (max 4 times, logged).
  await page.waitForTimeout(3_000);
  for (let i = 0; i < 4; i += 1) {
    await page.goto("/my-leads");
    if (await prompt.waitFor({ state: "visible", timeout: 12_000 }).then(() => true, () => false)) return prompt;
    logLines.push(`auto-prompt not shown on load ${i + 1}/4`);
  }
  await expect(prompt).toBeVisible({ timeout: 1_000 });
  return prompt;
}

async function fillPromptAndSave(prompt: Locator, page: Page, tick: Tick, opts: { gateSave?: boolean } = {}): Promise<{ saved: boolean }> {
  await prompt.getByTestId("post-call-outcome-reached").click();
  if (tick.expected.noteMarker) await prompt.getByTestId("post-call-note").fill(tick.expected.noteMarker);
  const pick = tick.expected.appointment?.pick;
  if (pick) await prompt.getByTestId(pick === "next_week" ? "post-call-pick-next-week" : pick === "tomorrow" ? "post-call-pick-tomorrow" : "post-call-pick-3-days").click();
  let gate: string | null = null;
  if (opts.gateSave) gate = await run.control.arm("response_sent", { source: "app", pathIncludes: "/my-leads" });
  await prompt.getByRole("button", { name: /^save$/i }).click();
  if (gate) {
    // Lost response at the boundary: the app finished the save; hold its answer, reload, then release.
    await run.control.wait(gate, 30_000);
    await page.reload();
    await run.control.release(gate);
    return { saved: false };
  }
  await expect(prompt.getByTestId("post-call-receipt")).toBeVisible({ timeout: 30_000 });
  return { saved: true };
}

type Runner = (page: Page, context: BrowserContext, tick: Tick, rec: TickRecord) => Promise<void>;

/** After a save: the appointment the UI created (so the oracle can follow it through reschedules). */
async function noteAppointment(rec: TickRecord, propertyId: string): Promise<void> {
  const r = await run.db.query<{ id: string }>("select id from public.tasks where related_property_id=$1 and type='appointment' and status='open' order by created_at desc limit 1", [propertyId]);
  rec.appointmentTaskId = r.rows[0]?.id ?? null;
}

const RUNNERS: Record<string, Runner> = {
  async clean_call(page, _c, tick, rec) {
    const lead = run.lead(tick);
    await awaitDialWindow(run.ctx, lead);
    await openCallScreen(page, lead.propertyId);
    const it = await clickCallAndWaitIntent(page, lead.propertyId);
    rec.intentIds.push(it.id);
    rec.callIds.push(await finishCallViaEvents(lead.propertyId, tick, it.customData));
    rec.actionTime = new Date().toISOString();
    await fillPromptAndSave(await openAutoPrompt(page, lead), page, tick);
    await noteAppointment(rec, lead.propertyId);
    // back/forward after save must not re-save or re-open the prompt for a second write.
    await page.goBack().catch(() => {});
    await page.goForward().catch(() => {});
  },

  async double_click_dial(page, _c, tick, rec) {
    const lead = run.lead(tick);
    await awaitDialWindow(run.ctx, lead);
    await openCallScreen(page, lead.propertyId);
    const first = await clickCallAndWaitIntent(page, lead.propertyId, true); // one key, double-clicked
    rec.intentIds.push(first.id);
    // A reload and a fresh click while the first call is in flight: the app must refuse, never dial again.
    await page.reload();
    await expect(page.getByTestId(`call-button-${lead.propertyId}`)).toBeVisible();
    await page.getByTestId(`call-button-${lead.propertyId}`).click();
    await page.waitForTimeout(3_000); // observation window for a (wrong) second authorization
    const authorized = (await run.db.query<{ n: number }>("select count(*)::int n from public.dialpad_call_intents where property_id=$1 and dispatch_authorized_at is not null", [lead.propertyId])).rows[0]!.n;
    if (authorized > 1) rec.rejections.push({ step: "second_dial_in_flight", code: "DIALED_TWICE" });
    // No provider event arrives: the intent expires (lever), the retry dials once.
    await expireIntent(run.db, first.id);
    rec.expiredAt = new Date().toISOString();
    await awaitDialWindow(run.ctx, lead);
    await openCallScreen(page, lead.propertyId);
    const second = await clickCallAndWaitIntent(page, lead.propertyId, false, first.id);
    rec.intentIds.push(second.id);
    rec.callIds.push(await finishCallViaEvents(lead.propertyId, tick, second.customData));
    await fillPromptAndSave(await openAutoPrompt(page, lead), page, tick);
  },

  async lost_response(page, _c, tick, rec) {
    // The mock SMS provider cannot be gated server-side; the boundary exercised here is the APP's response for a save.
    const lead = run.lead(tick);
    await awaitDialWindow(run.ctx, lead);
    await openCallScreen(page, lead.propertyId);
    const it = await clickCallAndWaitIntent(page, lead.propertyId);
    rec.intentIds.push(it.id);
    rec.callIds.push(await finishCallViaEvents(lead.propertyId, tick, it.customData));
    await fillPromptAndSave(await openAutoPrompt(page, lead), page, tick, { gateSave: true });
    // After the reload the saved state must be visible (a second Save is only allowed once the first is resolved).
    await expect.poll(async () => (await run.db.query("select 1 from public.acquisition_attempts where property_id=$1 and source='dialpad' and outcome is not null", [lead.propertyId])).rowCount, { timeout: 30_000 }).toBe(1);
  },

  async second_tab_retry(page, context, tick, rec) {
    const lead = run.lead(tick);
    await awaitDialWindow(run.ctx, lead);
    await openCallScreen(page, lead.propertyId);
    const it = await clickCallAndWaitIntent(page, lead.propertyId);
    rec.intentIds.push(it.id);
    // Both tabs load the queue right after the call ends. The app acknowledges a prompt once one tab shows it, so only one tab may ever get
    // one (the app dedupes). Whichever tabs show it save with their own submission id (the race the plan wants).
    const other = await context.newPage();
    rec.callIds.push(await finishCallViaEvents(lead.propertyId, tick, it.customData));
    // The prompt list is read when a queue page loads: both tabs load it at the same moment, after the call ended.
    await page.waitForTimeout(3_000);
    await Promise.all([other.goto("/my-leads"), page.goto("/my-leads")]);
    const loc = (p: Page) => p.getByTestId("post-call-prompt").filter({ hasText: lead.address }).first();
    const tabs = [{ name: "one", page, prompt: loc(page) }, { name: "two", page: other, prompt: loc(other) }];
    const shown = new Set<string>();
    const until = Date.now() + 90_000;
    let firstAt = 0;
    while (Date.now() < until && (shown.size === 0 || Date.now() < firstAt + 15_000)) {
      for (const t of tabs) if (!shown.has(t.name) && (await t.prompt.isVisible().catch(() => false))) { shown.add(t.name); firstAt = firstAt || Date.now(); }
      if (shown.size === tabs.length) break;
      await page.waitForTimeout(500);
    }
    expect(shown.size, "at least one tab shows the prompt for the call").toBeGreaterThan(0);
    rec.actionTime = new Date().toISOString();
    for (const t of tabs) {
      if (!shown.has(t.name)) { rec.steps.push(`tab ${t.name} never showed the prompt (acknowledged elsewhere)`); continue; }
      await fillPromptAndSave(t.prompt, t.page, tick).catch((e) => rec.rejections.push({ step: `save_tab_${t.name}`, code: (e as Error).message.slice(0, 80) }));
    }
    await other.close();
    await noteAppointment(rec, lead.propertyId);
  },

  async two_tabs_edits(page, context, tick, rec) {
    const lead = run.lead(tick);
    const other = await context.newPage();
    await page.goto(`/leads/${lead.propertyId}`);
    await other.goto(`/leads/${lead.propertyId}`);
    // Distinct notes from two tabs at once (real note composer), then two edits of the one appointment.
    const m = tick.expected.noteMarker!;
    await page.getByLabel("Add a note").fill(m);
    await other.getByLabel("Add a note").fill(`${m} (tab two)`);
    await Promise.all([page.getByLabel("Add a note").press("Control+Enter"), other.getByLabel("Add a note").press("Control+Enter")]);
    await expect(page.getByTestId("lead-activity-note").filter({ hasText: m }).first()).toBeVisible({ timeout: 30_000 });
    const created = await createAppointment(run.ctx, lead, { title: `Call ${lead.address}`, pick: "tomorrow", now: new Date() });
    expect(created.ok, `appointment ${created.code}`).toBe(true);
    rec.appointmentTaskId = created.taskId ?? null;
    await rescheduleAppointment(run.ctx, created.taskId!, "next_week", new Date());
    await page.waitForTimeout(50);
    rec.actionTime = new Date().toISOString();
    await rescheduleAppointment(run.ctx, created.taskId!, "three_days", new Date(rec.actionTime));
    await Promise.all([page.reload(), other.reload()]);
    await expect(page.getByTestId("lead-next-action")).toBeVisible({ timeout: 20_000 });
    await other.close();
  },

  async offline_send(page, context, tick, rec) {
    // Offline during Send, back online: one provider request. Drives the contract card on the call screen (not exercised locally).
    const lead = run.lead(tick);
    await openCallScreen(page, lead.propertyId);
    const card = page.getByTestId("send-contract-card");
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.getByTestId("contract-price").fill("250000");
    const send = card.getByRole("button", { name: /send/i }).first();
    await context.setOffline(true);
    await send.click(); // fails to leave the browser; no request, no provider call
    await context.setOffline(false);
    const restore = await slow3g(page);
    await expect(send).toBeEnabled({ timeout: 30_000 });
    await send.click();
    await restore();
    const sends = await retryNonMutating("provider send observed", async () => {
      const log = await run.control.log();
      return log.records.filter((r) => r.provider === "dropbox_sign" && r.outcome === "accepted");
    }, logLines);
    rec.steps.push(`provider sends observed: ${sends.length}`);
  },
};

test.describe.configure({ mode: "serial" });
for (const tick of run.ticks) {
  test(`stress t${tick.tick} ${tick.scenario}${tick.args.variant ? `/${String(tick.args.variant)}` : ""}`, async ({ page, context }) => {
    test.setTimeout(300_000); // dial pacing (4/min) and first-compile of a dev page are slow; the gestures themselves are not
    const runner = RUNNERS[tick.scenario];
    const rec = newRecord(tick, run.lead(tick));
    try {
      if (!runner) throw new Error(`no browser runner for ${tick.scenario}`);
      await signIn(context, page);
      await runner(page, context, tick, rec);
      rec.finishedAt = new Date().toISOString();
      recordResult(run.dir, tick.tick, true, undefined, rec);
    } catch (e) {
      rec.finishedAt = new Date().toISOString();
      rec.error = (e as Error).message.slice(0, 300);
      recordResult(run.dir, tick.tick, false, rec.error, rec);
      throw e;
    }
  });
}

test.afterAll(async () => { await run.db.end(); });
