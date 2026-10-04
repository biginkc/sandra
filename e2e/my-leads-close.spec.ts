import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";
import pg from "pg";

import { adminClient, DEFAULT_ORG_ID, ensureTestUser, resetTenantTables } from "./fixtures";
import {
  assertLaneSafe,
  CI_DIALPAD_USER_ID,
  ciDatabaseUrl,
  createSyntheticLead,
  designateRep,
  dialpadEventPayload,
  asMember,
  postDialpadEvent,
  prepareDialpadIntent,
  resetCloseWorld,
  retireSyntheticLead,
  seedDialpadForRep,
  seedFeatureFlags,
  seedSellerReminderSettings,
  signDialpadWebhook,
  type SyntheticLead,
} from "./support/my-leads-close-fixture";
import { quickPickDueAt } from "../src/lib/my-leads/quick-picks";

/**
 * my-leads-close: Phase 1 CI acceptance lane (TECH-PLAN Phase 4, item 4.3, Phase 1 cases).
 *
 * Deterministic, stubbed providers, disposable database only. Flags are turned on for the test org
 * inside this file's own setup (never by a migration). Phase 2 (dial, native match) and Phase 3
 * (comps, contract) cases are typed TODO hooks at the bottom; they land with the p2-acceptance slice
 * and the main p4 PR. Test titles all start with `my-leads-close:` so CI can grep them into a
 * dedicated step (see .github/workflows/e2e.yml).
 */

const BASE_URL = "http://localhost:3456";
const WEBHOOK_SECRET = process.env.DIALPAD_CTI_WEBHOOK_SECRET_E2E ?? "e2e-dialpad-secret-0123456789";
const CRON_SECRET = process.env.E2E_CRON_SECRET ?? "e2e-cron-secret-0123456789";
const SHARE_LINK = "https://dialpad.com/callreview/e2e-close-share";
const ADMIN_RECORDING = "https://dialpad.com/blob/adminrecording/e2e-close.mp3";

const ciLane = process.env.E2E_DISPOSABLE_DATABASE === "1";

type World = {
  db: pg.Pool;
  repUserId: string;
  runTag: string;
  lead: SyntheticLead;
  taskId: string | null;
};

const world: Partial<World> = {};

test.describe.serial("my-leads-close: Phase 1 CI lane", () => {
  test.setTimeout(120_000);
  test.skip(!ciLane, "my-leads-close runs only against the disposable CI database (E2E_DISPOSABLE_DATABASE=1).");

  test.beforeAll(async () => {
    assertLaneSafe("ci");
    const admin = adminClient();
    await resetTenantTables(admin);
    const repUserId = await ensureTestUser(admin);
    const db = new pg.Pool({ connectionString: ciDatabaseUrl(), max: 3 });
    const runTag = `E2E-CLOSE ${randomUUID().slice(0, 8)}`;
    await designateRep(db, { orgId: DEFAULT_ORG_ID, repUserId });
    // Phase 1 surfaces on; seller_reminders deliberately OFF (the schedule row must exist, nothing may send).
    await seedFeatureFlags(db, DEFAULT_ORG_ID, ["call_next_strip", "post_call_prompt"]);
    await seedSellerReminderSettings(db, DEFAULT_ORG_ID, true);
    const lead = await createSyntheticLead(db, { orgId: DEFAULT_ORG_ID, repUserId, runTag, phoneE164: "+18165550142", lastTouchDaysAgo: 20 });
    Object.assign(world, { db, repUserId, runTag, lead, taskId: null });
  });

  test.afterAll(async () => {
    const { db, repUserId } = world;
    if (!db) return;
    try {
      // Put the test org back to its defaults: flags, Dialpad connection/binding, reminder settings, designation.
      if (repUserId) await resetCloseWorld(db, { orgId: DEFAULT_ORG_ID, repUserId });
    } finally {
      await db.end();
    }
  });

  test("my-leads-close: T0 seam preflight (S4 test ids, S5 quick-pick oracle, S7 flags)", async () => {
    const root = path.resolve(__dirname, "..");
    const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
    const seams: Array<[string, string, RegExp]> = [
      ["S4 strip", "src/app/(dashboard)/my-leads/_components/call-next-strip.tsx", /data-testid="call-next-strip"/],
      ["S4 strip row", "src/app/(dashboard)/my-leads/_components/call-next-row.tsx", /call-next-reason-\$\{propertyId\}/],
      ["S4 prompt", "src/app/(dashboard)/my-leads/_components/post-call-prompt.tsx", /post-call-pick-next-week/],
      ["S4 prompt outcome", "src/app/(dashboard)/my-leads/_components/post-call-prompt.tsx", /data-testid="post-call-outcome"/],
      ["S4 prompt note", "src/app/(dashboard)/my-leads/_components/post-call-prompt.tsx", /data-testid="post-call-note"/],
      ["S4 my leads row", "src/app/(dashboard)/my-leads/_components/queue-row.tsx", /data-next-step-due-at/],
      ["S4 lead page", "src/app/(dashboard)/leads/[id]/next-action-card.tsx", /data-next-step-id/],
      ["S4 calendar", "src/app/(dashboard)/calendar/_components/appointment-block.tsx", /data-next-step-id/],
      ["S4 dashboard", "src/app/(dashboard)/dashboard/_components/tasks-panel.tsx", /data-next-step-id/],
      ["S5 quickPickDueAt", "src/lib/my-leads/quick-picks.ts", /export function quickPickDueAt/],
      ["S7 flags", "src/lib/my-leads/flags.ts", /my_leads_feature_flags/],
      ["S8 relabel marker", "supabase/migrations/20261005121500_next_step_relabel_functions.sql", /relabel_2026_10/],
    ];
    const missing = seams.filter(([, file, pattern]) => !fs.existsSync(path.join(root, file)) || !pattern.test(read(file))).map(([name]) => name);
    expect(missing, `missing Phase 1 seams: ${missing.join(", ")}`).toEqual([]);
    expect(() => assertLaneSafe("ci")).not.toThrow();
  });

  test("my-leads-close: T1 synthetic non-training lead shows in the Call next strip with the RPC's reason", async ({ page }) => {
    const { db, lead, repUserId } = world as World;
    const training = await db.query<{ is_training: boolean }>("select is_training from public.properties where id=$1", [lead.propertyId]);
    expect(training.rows[0]?.is_training).toBe(false);

    const rpc = await asMember(db, repUserId, (q) =>
      q.query<{ v: { rows: Array<{ propertyId: string; tier: number; reason: string }> } }>(
        "select public.fn_get_my_leads_call_next($1,$2,10) as v",
        [DEFAULT_ORG_ID, repUserId],
      ),
    );
    const mine = rpc.rows[0]!.v.rows.find((r) => r.propertyId === lead.propertyId);
    expect(mine, "the strip RPC ranks the synthetic lead").toBeTruthy();
    expect(mine!.tier).toBe(5);
    expect(mine!.reason).toBe("longest_since_touch");

    await page.goto("/my-leads");
    const strip = page.getByTestId("call-next-strip");
    await expect(strip).toBeVisible({ timeout: 20_000 });
    const row = page.getByTestId(`call-next-row-${lead.propertyId}`);
    await expect(row).toBeVisible();
    await expect(page.getByTestId(`call-next-reason-${lead.propertyId}`)).toContainText(/since|touch|day/i);
  });

  test("my-leads-close: T4 post-call prompt outcome + note + Next week creates one phone appointment seen identically everywhere", async ({ page }) => {
    const { db, lead } = world as World;
    const before = await db.query<{ n: string }>("select count(*)::text as n from public.tasks where related_property_id=$1 and status in ('open','snoozed')", [lead.propertyId]);
    expect(Number(before.rows[0]!.n)).toBe(0);

    await page.goto("/my-leads");
    const row = page.locator(`[data-testid^="my-lead-row-${lead.propertyId}"]`).first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.getByRole("button").first().click();
    const actions = page.locator(`[data-testid^="my-lead-actions-${lead.propertyId}"]`).first();
    await expect(actions).toBeVisible();
    await actions.getByRole("button", { name: /log attempt/i }).click();

    const prompt = page.getByTestId("post-call-prompt");
    await expect(prompt).toBeVisible();
    await prompt.getByTestId("post-call-outcome-reached").click();
    const note = `${lead.runTag} seller wants a call back next week`;
    await prompt.getByTestId("post-call-note").fill(note);
    const clickedAt = new Date();
    await prompt.getByTestId("post-call-pick-next-week").click();
    await prompt.getByRole("button", { name: /^save$/i }).click();
    await expect(prompt.getByTestId("post-call-receipt")).toBeVisible({ timeout: 20_000 });

    const expectedDue = quickPickDueAt("next_week", clickedAt).toISOString();
    const openTasks = () =>
      db.query<{ id: string; type: string; mode: string; due_at: Date; end_at: Date }>(
        "select id,type,mode,due_at,end_at from public.tasks where related_property_id=$1 and status in ('open','snoozed') order by created_at desc",
        [lead.propertyId],
      );
    await expect.poll(async () => (await openTasks()).rows.length, { timeout: 20_000 }).toBe(1);
    const task = (await openTasks()).rows[0]!;
    expect(task.type).toBe("appointment");
    expect(task.mode).toBe("phone");
    expect(new Date(task.due_at).toISOString()).toBe(expectedDue);
    expect(new Date(task.end_at).getTime() - new Date(task.due_at).getTime()).toBe(15 * 60_000);
    const legacy = await db.query<{ n: string }>("select count(*)::text as n from public.tasks where type in ('follow_up','callback') and related_property_id=$1", [lead.propertyId]);
    expect(Number(legacy.rows[0]!.n)).toBe(0);
    const notes = await db.query<{ body: string }>("select body from public.lead_notes where property_id=$1", [lead.propertyId]);
    expect(notes.rows.map((n) => n.body)).toContain(note);
    world.taskId = task.id;

    const dueIso = new Date(task.due_at).toISOString();
    const attrs = async (locatorPage: Page, selector: string) => {
      const el = locatorPage.locator(selector).first();
      await expect(el).toBeAttached({ timeout: 20_000 });
      return {
        id: await el.getAttribute("data-next-step-id"),
        due: await el.getAttribute("data-next-step-due-at"),
      };
    };

    // My Leads row
    await page.goto("/my-leads");
    const myLeads = await attrs(page, `[data-testid^="my-lead-row-${lead.propertyId}"] [data-next-step-due-at]`);
    expect(new Date(myLeads.due ?? "").toISOString()).toBe(dueIso);

    // Lead page
    await page.goto(`/leads/${lead.propertyId}`);
    const leadPage = await attrs(page, `[data-testid="lead-next-action"][data-next-step-id="${task.id}"]`);
    expect(leadPage.id).toBe(task.id);
    expect(new Date(leadPage.due ?? "").toISOString()).toBe(dueIso);

    // Calendar (month containing the due date)
    const dueDay = new Date(task.due_at);
    const month = `${dueDay.getUTCFullYear()}-${String(dueDay.getUTCMonth() + 1).padStart(2, "0")}`;
    await page.goto(`/calendar?view=month&month=${month}`);
    const calendar = await attrs(page, `[data-next-step-id="${task.id}"]`);
    expect(calendar.id).toBe(task.id);
    expect(new Date(calendar.due ?? "").toISOString()).toBe(dueIso);
  });

  test("my-leads-close: T4b seller reminder schedule row is created but nothing sends while the flag is off", async () => {
    const { db, lead, taskId } = world as World;
    expect(taskId, "T4 must have created the appointment").toBeTruthy();
    const client = await db.connect();
    let scheduled: { rows: Array<{ r: { scheduled: number; skipped: number } }> };
    try {
      // The outbox functions require the service_role claim (never a browser role).
      await client.query("begin");
      await client.query("select set_config('request.jwt.claim.role','service_role',true)");
      scheduled = await client.query<{ r: { scheduled: number; skipped: number } }>(
        "select public.fn_schedule_seller_reminders('30000 days'::interval, 200, array[$1]::uuid[]) as r",
        [DEFAULT_ORG_ID],
      );
      await client.query("commit");
    } finally {
      client.release();
    }
    expect(scheduled.rows[0]!.r.scheduled + scheduled.rows[0]!.r.skipped).toBeGreaterThanOrEqual(1);
    const row = await db.query<{ status: string; task_id: string }>("select status, task_id from public.seller_appointment_reminders where task_id=$1", [taskId]);
    expect(row.rows).toHaveLength(1);
    expect(["pending", "skipped"]).toContain(row.rows[0]!.status);

    // Drive the cron by hand (crons never run on previews or in CI). Flag off: it must send nothing.
    const response = await fetch(`${BASE_URL}/api/cron/seller-appointment-reminders`, { headers: { authorization: `Bearer ${CRON_SECRET}` } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok?: boolean; disabled?: string; claimed?: number; results?: Record<string, number> };
    expect(body.ok).toBe(true);
    expect(body.disabled, "the seller_reminders flag is off, so the job reports itself disabled").toBe("flag_off");
    expect(body.claimed).toBeUndefined();
    expect(body.results).toBeUndefined();
    const after = await db.query<{ status: string; message_id: string | null }>("select status, message_id from public.seller_appointment_reminders where task_id=$1", [taskId]);
    expect(after.rows[0]!.status).not.toBe("sent");
    expect(after.rows[0]!.message_id).toBeNull();
    const messages = await db.query<{ n: string }>("select count(*)::text as n from public.messages where contact_id=$1 and direction='outbound'", [lead.contactId]);
    expect(Number(messages.rows[0]!.n)).toBe(0);
  });

  test("my-leads-close: T3-link stubbed hangup event captures the recording link on the attempt and the call activity", async () => {
    const { db, lead, repUserId } = world as World;
    const { connectionId } = await seedDialpadForRep(db, { orgId: DEFAULT_ORG_ID, repUserId });
    const intent = await prepareDialpadIntent(db, { orgId: DEFAULT_ORG_ID, repUserId, lead });
    const callId = `65432109876543${String(Date.now()).slice(-5)}`;
    const start = Date.now() - 120_000;
    const events = [
      dialpadEventPayload({ callId, state: "calling", at: start, customData: intent.customData, externalNumber: lead.phoneE164, targetUserId: CI_DIALPAD_USER_ID }),
      dialpadEventPayload({ callId, state: "connected", at: start + 4000, customData: intent.customData, externalNumber: lead.phoneE164, targetUserId: CI_DIALPAD_USER_ID, dateStarted: start }),
      dialpadEventPayload({
        callId, state: "hangup", at: start + 64_000, customData: intent.customData, externalNumber: lead.phoneE164, targetUserId: CI_DIALPAD_USER_ID,
        dateStarted: start, dateConnected: start + 4000, shareLink: SHARE_LINK, adminRecordingUrl: ADMIN_RECORDING,
      }),
    ];
    for (const payload of events) {
      const response = await postDialpadEvent(BASE_URL, connectionId, signDialpadWebhook(payload, WEBHOOK_SECRET));
      expect(response.status, await response.text().catch(() => "")).toBe(200);
    }
    await expect
      .poll(async () => (await db.query<{ status: string }>("select status from public.dialpad_call_intents where id=$1", [intent.intentId])).rows[0]?.status, { timeout: 20_000 })
      .toBe("matched");
    const attempt = await db.query<{ recording_url: string | null; call_activity_id: string | null }>(
      "select recording_url, call_activity_id from public.acquisition_attempts where property_id=$1 and source='dialpad' order by created_at desc limit 1",
      [lead.propertyId],
    );
    expect(attempt.rows).toHaveLength(1);
    expect(attempt.rows[0]!.recording_url).toBe(SHARE_LINK);
    const activity = await db.query<{ provider_recording_url: string | null }>("select provider_recording_url from public.call_activities where id=$1", [attempt.rows[0]!.call_activity_id]);
    expect(activity.rows[0]?.provider_recording_url).toBe(ADMIN_RECORDING);

    // Replay creates no second attempt.
    for (const payload of events) await postDialpadEvent(BASE_URL, connectionId, signDialpadWebhook(payload, WEBHOOK_SECRET));
    const count = await db.query<{ n: string }>("select count(*)::text as n from public.acquisition_attempts where property_id=$1 and source='dialpad'", [lead.propertyId]);
    expect(Number(count.rows[0]!.n)).toBe(1);
  });

  test("my-leads-close: T9 retire cancels the open appointment and soft-retires the lead; evidence is retained", async () => {
    const { db, lead, repUserId } = world as World;
    const report = await retireSyntheticLead(db, lead, repUserId);
    expect(report.openTasks).toBe(0);
    expect(report.propertyDeletedAt).not.toBeNull();
    expect(report.cancelledTasks).toBeGreaterThanOrEqual(1);
    expect(report.attempts).toBeGreaterThanOrEqual(2);
    expect(report.notes).toBeGreaterThanOrEqual(1);
    expect(report.intents).toBeGreaterThanOrEqual(1);
    const stillThere = await db.query<{ n: string }>("select count(*)::text as n from public.properties where id=$1", [lead.propertyId]);
    expect(Number(stillThere.rows[0]!.n)).toBe(1);
  });

  // TODO Phase 2 (p2-acceptance slice): T3 stub dial -> hangup -> prompt auto-open, T5 callback banner/pin,
  // T7 training isolation, T8 native-match. TODO Phase 3 (main p4 PR): T2 comps, T6 contract send.
  test.fixme("my-leads-close: T3 stub dial record matches the intent (Phase 2)", async () => {});
  test.fixme("my-leads-close: T2 comp this lead with the fixture provider (Phase 3)", async () => {});
  test.fixme("my-leads-close: T6 send contract through the Dropbox Sign stub (Phase 3)", async () => {});
});
