import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";
import pg from "pg";

import { adminClient, DEFAULT_ORG_ID, ensureTestUser, resetTenantTables } from "./fixtures";
import {
  asMember,
  assertLaneSafe,
  CI_DIALPAD_USER_ID,
  ciDatabaseUrl,
  createSyntheticLead,
  designateRep,
  dialpadEventPayload,
  expireDialIntentCi,
  postDialpadEvent,
  prepareDialpadIntent,
  purgeDialpadEvidenceCi,
  readDialIntents,
  readEventDispositions,
  resetCloseWorld,
  seedDialpadForRep,
  seedFeatureFlags,
  signDialpadWebhook,
  type SyntheticLead,
} from "./support/my-leads-close-fixture";

/**
 * my-leads-close Phase 2 CI acceptance slice (TECH-PLAN 4.3: T0 Phase 1-2 seams, T3, T7, T8).
 *
 * Synthetic non-training leads on a disposable database only; Dialpad is the stub dial provider
 * (`DIALPAD_DIAL_PROVIDER=stub`, no HTTP) plus locally signed webhook events posted to the app. No
 * real Dialpad, no real number: every phone is a 555-01xx fictional number. Phase 2's activation
 * gate (2.11, Release 2) runs this file at the released SHA. All titles start with
 * `my-leads-close:` so CI can grep them into the dedicated step in .github/workflows/e2e.yml.
 *
 * Two plan items cannot be proven from here and are stated honestly rather than faked:
 *  - the stub dial request body (phone, custom_data, caller id) lives in the Next server's memory;
 *    the spec reads the durable intent row instead (see readDialIntents in the fixture);
 *  - the strip's "Assign to lead" affordance for ambiguous native calls is not rendered in p2-ui
 *    (the poll fetches the list, no component shows it), so T8 asserts the list through the rep's
 *    own RPC, which is what the UI will read.
 */

const BASE_URL = "http://localhost:3456";
const WEBHOOK_SECRET = process.env.DIALPAD_CTI_WEBHOOK_SECRET_E2E ?? "e2e-dialpad-secret-0123456789";
const SHARE_LINK = "https://dialpad.com/callreview/e2e-close-p2-share";
const ADMIN_RECORDING = "https://dialpad.com/blob/adminrecording/e2e-close-p2.mp3";
const PHONE_MAIN = "+18165550142";
const PHONE_NATIVE = "+18165550143";
const PHONE_SHARED = "+18165550144";
const PHONE_UNKNOWN = "+18165550199";
const PHONE_TRAINING = "+18165550145";

const ciLane = process.env.E2E_DISPOSABLE_DATABASE === "1";

type World = { db: pg.Pool; repUserId: string; connectionId: string; runTag: string; lead: SyntheticLead };
const world: Partial<World> = {};

/** A fresh 19-digit Dialpad call id (the verifier keeps int64 ids intact). */
function newCallId(): string {
  return `65432${Date.now().toString().padStart(13, "0")}${Math.floor(Math.random() * 1000).toString().padStart(3, "0")}`.slice(0, 19);
}

async function postEvent(input: Parameters<typeof dialpadEventPayload>[0]): Promise<void> {
  const { connectionId } = world as World;
  const text = dialpadEventPayload(input);
  const res = await postDialpadEvent(BASE_URL, connectionId, signDialpadWebhook(text, WEBHOOK_SECRET));
  expect(res.status, `webhook accepted ${input.state}`).toBeLessThan(300);
}

/** calling, connected, hangup for one call; hangup carries the recording evidence when asked. */
async function postCall(input: { callId: string; externalNumber: string; customData?: string; direction?: "outbound" | "inbound"; recorded?: boolean }): Promise<void> {
  const start = Date.now();
  const common = { callId: input.callId, externalNumber: input.externalNumber, targetUserId: CI_DIALPAD_USER_ID, customData: input.customData, direction: input.direction, dateStarted: start };
  await postEvent({ ...common, state: "calling", at: start });
  await postEvent({ ...common, state: "connected", at: start + 4_000, dateConnected: start + 4_000 });
  await postEvent({
    ...common, state: "hangup", at: start + 64_000, dateConnected: start + 4_000, talkTimeMs: 60_000,
    ...(input.recorded ? { shareLink: SHARE_LINK, adminRecordingUrl: ADMIN_RECORDING } : {}),
  });
}

async function attemptsFor(db: pg.Pool, propertyId: string) {
  return (
    await db.query<{ id: string; recording_url: string | null; provider_attempt_key: string | null; outcome: string | null }>(
      "select id,recording_url,provider_attempt_key,outcome from public.acquisition_attempts where property_id=$1 and source='dialpad' order by created_at",
      [propertyId],
    )
  ).rows;
}

async function clickCall(page: Page, propertyId: string): Promise<void> {
  const button = page.getByTestId(`call-next-action-call-${propertyId}`);
  await expect(button).toBeEnabled({ timeout: 20_000 });
  await button.click();
}

test.describe.serial("my-leads-close: Phase 2 CI lane", () => {
  test.setTimeout(150_000);
  test.skip(!ciLane, "my-leads-close runs only against the disposable CI database (E2E_DISPOSABLE_DATABASE=1).");

  test.beforeAll(async () => {
    assertLaneSafe("ci");
    const admin = adminClient();
    await resetTenantTables(admin);
    const repUserId = await ensureTestUser(admin);
    const db = new pg.Pool({ connectionString: ciDatabaseUrl(), max: 3 });
    Object.assign(world, { db, repUserId });
    const runTag = `E2E-CLOSE-P2 ${randomUUID().slice(0, 8)}`;
    await designateRep(db, { orgId: DEFAULT_ORG_ID, repUserId });
    await seedFeatureFlags(db, DEFAULT_ORG_ID, ["call_next_strip", "post_call_prompt", "click_to_dial", "native_matcher", "auto_prompt", "callback_alert"]);
    const { connectionId } = await seedDialpadForRep(db, { orgId: DEFAULT_ORG_ID, repUserId });
    const lead = await createSyntheticLead(db, { orgId: DEFAULT_ORG_ID, repUserId, runTag, phoneE164: PHONE_MAIN, lastTouchDaysAgo: 20 });
    Object.assign(world, { db, repUserId, connectionId, runTag, lead });
  });

  test.afterAll(async () => {
    const { db, repUserId } = world;
    if (!db) return;
    try {
      if (repUserId) await resetCloseWorld(db, { orgId: DEFAULT_ORG_ID, repUserId });
    } finally {
      try {
        await purgeDialpadEvidenceCi(db);
      } finally {
        await db.end();
      }
    }
  });

  test("my-leads-close: T0 Phase 1-2 seam preflight", async () => {
    const root = path.resolve(__dirname, "..");
    const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
    const my = "src/app/(dashboard)/my-leads";
    const seams: Array<[string, string, RegExp]> = [
      ["S1 dial provider switch", "src/lib/dialpad-cti/api-dial.ts", /DIALPAD_DIAL_PROVIDER/],
      ["S1 production ignores stub", "src/lib/dialpad-cti/api-dial.ts", /VERCEL_ENV === 'production'\) return 'live'/],
      ["S4 strip", `${my}/_components/call-next-strip.tsx`, /data-testid="call-next-strip"/],
      ["S4 strip row call", `${my}/_components/call-next-row.tsx`, /call-next-action-call-\$\{propertyId\}/],
      ["S4 prompt", `${my}/_components/post-call-prompt.tsx`, /data-testid="post-call-prompt"/],
      ["S4 prompt outcome", `${my}/_components/post-call-prompt.tsx`, /data-testid="post-call-outcome"/],
      ["S4 dial status", `${my}/_components/dial-status.tsx`, /data-testid="dial-status"/],
      ["S4 callback banner", `${my}/_components/callback-due-banner.tsx`, /data-testid="callback-due-banner"/],
      ["S6 poll uses timers not rAF", `${my}/_components/use-call-state-poll.ts`, /setTimeout/],
      ["S7 flags", "src/lib/my-leads/flags.ts", /my_leads_feature_flags/],
      ["S7 native matcher flag", "src/lib/my-leads/flags.ts", /native_matcher/],
      ["P2 ambiguous list RPC", `${my}/call-state-actions.ts`, /fn_list_ambiguous_native_calls/],
      ["P2 prompts RPC", `${my}/call-state-actions.ts`, /fn_list_unacknowledged_call_prompts/],
    ];
    const missing = seams.filter(([, file, pattern]) => !fs.existsSync(path.join(root, file)) || !pattern.test(read(file))).map(([name]) => name);
    expect(missing, `missing Phase 1-2 seams: ${missing.join(", ")}`).toEqual([]);
    const pollSource = read(`${my}/_components/use-call-state-poll.ts`);
    expect(pollSource).not.toMatch(/requestAnimationFrame/);
    expect(() => assertLaneSafe("ci")).not.toThrow();
  });

  test("my-leads-close: T3 dial (stub), hangup events, replay, and the post-call prompt opens only after other dialogs close", async ({ page }) => {
    const { db, lead } = world as World;
    expect(await readDialIntents(db, lead.propertyId)).toHaveLength(0);

    await page.goto("/my-leads");
    await expect(page.getByTestId("call-next-strip")).toBeVisible({ timeout: 20_000 });
    const button = page.getByTestId(`call-next-action-call-${lead.propertyId}`);
    await expect(button).toBeEnabled({ timeout: 20_000 });
    // Double click: idempotency key + in-flight guard mean exactly one dial.
    await button.dblclick();
    await expect(page.getByTestId("dial-status")).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => (await readDialIntents(db, lead.propertyId)).length, { timeout: 20_000 }).toBeGreaterThan(0);
    const intents = await readDialIntents(db, lead.propertyId);
    expect(intents).toHaveLength(1);
    const intent = intents[0]!;
    expect(intent.destinationE164).toBe(lead.phoneE164);
    expect(intent.customData).toMatch(/^sandra\.dialpad\.v1\.[0-9a-f]{48}$/);
    expect(intent.dispatchAuthorizedAt, "dial was authorized before the stub was called").not.toBeNull();

    // Another dialog is open when the call ends: the prompt must wait (the poll is suspended too).
    await page.getByTestId(`call-next-menu-${lead.propertyId}`).click();
    await page.getByTestId(`call-next-action-dead-nurture-${lead.propertyId}`).click();
    const handoff = page.locator("[role=dialog][data-state=open]").first();
    await expect(handoff).toBeVisible({ timeout: 10_000 });

    const callId = newCallId();
    await postCall({ callId, externalNumber: lead.phoneE164, customData: intent.customData, recorded: true });

    await expect.poll(async () => (await attemptsFor(db, lead.propertyId)).length, { timeout: 30_000 }).toBe(1);
    const [attempt] = await attemptsFor(db, lead.propertyId);
    expect(attempt!.recording_url).toBe(SHARE_LINK);
    expect(attempt!.provider_attempt_key).toBe(`dialpad-cti:${intent.id}`);
    const activity = await db.query<{ provider_recording_url: string | null }>(
      "select provider_recording_url from public.call_activities where provider='dialpad' and provider_call_id=$1",
      [callId],
    );
    expect(activity.rows[0]?.provider_recording_url).toBe(ADMIN_RECORDING);
    const matched = (await readDialIntents(db, lead.propertyId))[0]!;
    expect(matched.status).toBe("matched");
    expect(matched.matchedProviderCallId).toBe(callId);

    // Past one poll interval with the dialog still open: no prompt.
    await page.waitForTimeout(12_000);
    await expect(page.getByTestId("post-call-prompt")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.locator("[role=dialog][data-state=open]")).toHaveCount(0, { timeout: 10_000 });
    const prompt = page.getByTestId("post-call-prompt");
    await expect(prompt).toBeVisible({ timeout: 30_000 });
    // A reached call (60 s of talk time) pre-selects the reached outcome.
    await expect(prompt.getByTestId("post-call-outcome-reached")).toBeVisible();

    // Dismiss the prompt (acknowledges it) so later cases see only their own prompts.
    await page.keyboard.press("Escape");
    await expect(prompt).toHaveCount(0, { timeout: 10_000 });
    await expect
      .poll(async () => (await db.query<{ n: string }>("select count(*)::text as n from public.acquisition_attempts where property_id=$1 and prompt_acknowledged_at is not null", [lead.propertyId])).rows[0]!.n, { timeout: 15_000 })
      .toBe("1");

    // Replay: the same signed events again create nothing new.
    await postCall({ callId, externalNumber: lead.phoneE164, customData: intent.customData, recorded: true });
    await page.waitForTimeout(1_500);
    expect(await attemptsFor(db, lead.propertyId)).toHaveLength(1);
    expect(await readDialIntents(db, lead.propertyId)).toHaveLength(1);
  });

  test("my-leads-close: T3b expired call keeps its key for a retry, a deliberate Dismiss releases it", async ({ page }) => {
    const { db, repUserId, runTag } = world as World;
    const lead = await createSyntheticLead(db, { orgId: DEFAULT_ORG_ID, repUserId, runTag, phoneE164: "+18165550146", lastTouchDaysAgo: 40 });
    await page.goto("/my-leads");
    await clickCall(page, lead.propertyId);
    await expect.poll(async () => (await readDialIntents(db, lead.propertyId)).length, { timeout: 20_000 }).toBe(1);
    const first = (await readDialIntents(db, lead.propertyId))[0]!;
    await expireDialIntentCi(db, first.id);
    const status = page.getByTestId("dial-status");
    await expect(status).toContainText(/No confirmation from Dialpad/i, { timeout: 30_000 });

    // Automatic or repeated attempt without Dismiss reuses the key: the server only ever answers
    // already_dispatched, never a second intent.
    await clickCall(page, lead.propertyId);
    await page.waitForTimeout(2_000);
    expect(await readDialIntents(db, lead.propertyId), "retry after expiry reuses the same key").toHaveLength(1);

    // Deliberate Dismiss releases the key: the next click is a fresh dial.
    const dismiss = status.getByRole("button", { name: /dismiss/i });
    if (await dismiss.isVisible()) await dismiss.click();
    await expect(page.getByTestId("dial-status")).toHaveCount(0, { timeout: 10_000 });
    await clickCall(page, lead.propertyId);
    await expect.poll(async () => (await readDialIntents(db, lead.propertyId)).length, { timeout: 20_000 }).toBe(2);
    const intents = await readDialIntents(db, lead.propertyId);
    expect(new Set(intents.map((i) => i.idempotencyKey)).size, "fresh dial minted a new idempotency key").toBe(2);
  });

  test("my-leads-close: T7 training lead calls are isolated: internal_training, no attempt, no prompt", async ({ page }) => {
    const { db, repUserId, runTag } = world as World;
    const training = await createSyntheticLead(db, { orgId: DEFAULT_ORG_ID, repUserId, runTag: `${runTag} TRAIN`, phoneE164: PHONE_TRAINING, training: true });
    const intent = await prepareDialpadIntent(db, { orgId: DEFAULT_ORG_ID, repUserId, lead: training });
    const callId = newCallId();
    await postCall({ callId, externalNumber: training.phoneE164, customData: intent.customData, recorded: true });
    await expect
      .poll(async () => (await db.query("select 1 from public.call_activities where provider_call_id=$1", [callId])).rowCount, { timeout: 30_000 })
      .toBe(1);
    const activity = await db.query<{ call_purpose: string; property_id: string | null }>(
      "select call_purpose, property_id from public.call_activities where provider_call_id=$1",
      [callId],
    );
    expect(activity.rows[0]).toMatchObject({ call_purpose: "internal_training", property_id: null });
    const attempts = await db.query<{ n: string }>(
      "select count(*)::text as n from public.acquisition_attempts where property_id=$1",
      [training.propertyId],
    );
    expect(Number(attempts.rows[0]!.n)).toBe(0);
    // No prompt can exist for it: the prompt list is built from dialpad attempts, and there are none.
    await page.goto("/my-leads");
    await page.waitForTimeout(12_000);
    const dialpadAttempts = await db.query<{ n: string }>(
      "select count(*)::text as n from public.acquisition_attempts where property_id=$1 and source='dialpad'",
      [training.propertyId],
    );
    expect(Number(dialpadAttempts.rows[0]!.n)).toBe(0);
  });

  test("my-leads-close: T8 native call: one lead matches, shared number is ambiguous, unknown number is no_lead_match", async ({ page }) => {
    const { db, repUserId, runTag } = world as World;
    const one = await createSyntheticLead(db, { orgId: DEFAULT_ORG_ID, repUserId, runTag, phoneE164: PHONE_NATIVE, lastTouchDaysAgo: 25 });

    // One live lead with that number: matched, attempt keyed by the call id.
    const nativeCall = newCallId();
    await postCall({ callId: nativeCall, externalNumber: PHONE_NATIVE });
    await expect.poll(async () => (await attemptsFor(db, one.propertyId)).length, { timeout: 30_000 }).toBe(1);
    expect((await attemptsFor(db, one.propertyId))[0]!.provider_attempt_key).toBe(`dialpad-native:${nativeCall}`);
    await page.goto("/my-leads");
    await expect(page.getByTestId("post-call-prompt")).toBeVisible({ timeout: 40_000 });

    // The same number on two leads assigned to the rep: quarantined as ambiguous, listed for assignment.
    await createSyntheticLead(db, { orgId: DEFAULT_ORG_ID, repUserId, runTag, phoneE164: PHONE_SHARED, lastTouchDaysAgo: 26 });
    await createSyntheticLead(db, { orgId: DEFAULT_ORG_ID, repUserId, runTag, phoneE164: PHONE_SHARED, lastTouchDaysAgo: 27 });
    const ambiguousCall = newCallId();
    await postCall({ callId: ambiguousCall, externalNumber: PHONE_SHARED });
    await expect
      .poll(async () => new Set(await readEventDispositions(db, DEFAULT_ORG_ID, ambiguousCall)).has("quarantined:ambiguous_lead"), { timeout: 30_000 })
      .toBe(true);
    // The list RPC needs the rep's JWT identity (F4), so read it through the member helper.
    const ambiguousList = await asMember(db, repUserId, (q) => q.query<{ v: unknown }>("select public.fn_list_ambiguous_native_calls($1) as v", [DEFAULT_ORG_ID]));
    expect(JSON.stringify(ambiguousList.rows[0]!.v)).toContain(ambiguousCall);

    // Unknown number: quarantined no_lead_match, no attempt anywhere.
    const unknownCall = newCallId();
    await postCall({ callId: unknownCall, externalNumber: PHONE_UNKNOWN });
    await expect
      .poll(async () => new Set(await readEventDispositions(db, DEFAULT_ORG_ID, unknownCall)).has("quarantined:no_lead_match"), { timeout: 30_000 })
      .toBe(true);
    const stray = await db.query<{ n: string }>("select count(*)::text as n from public.acquisition_attempts where provider_attempt_key=$1", [`dialpad-native:${unknownCall}`]);
    expect(Number(stray.rows[0]!.n)).toBe(0);
  });
});
