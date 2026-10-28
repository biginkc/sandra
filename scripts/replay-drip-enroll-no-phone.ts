#!/usr/bin/env tsx
/**
 * Re-try the drip for leads held `drip_enroll_failed:no_phone` because the lead
 * had no saved homeowner (imports that link people only through
 * `property_contacts`). The fix in `enrollLead` (explicit `contactId`) makes the
 * same enrolment succeed for the contact who replied; this replays it once.
 *
 * Dry run is the default: reads the database, writes nothing, prints one line
 * per held lead (property, contact, route) and what --apply would do.
 * --apply needs an explicit human yes on the dry-run list (these are real
 * sellers who will be texted by the drip).
 *
 * Usage
 *   vercel env pull --environment=production <scratch>/.env.sandra-prod
 *   env $(grep -v '^#' <scratch>/.env.sandra-prod | xargs) \
 *     node --conditions=react-server --import tsx scripts/replay-drip-enroll-no-phone.ts [--apply] [--only <propertyId>]...
 * (`--conditions=react-server` lets the `server-only` imports load outside Next.)
 *
 * What a lead needs to be replayed (anything else is listed as skipped):
 * - still flagged, reason exactly `drip_enroll_failed:no_phone`, no saved homeowner;
 * - its newest `drip_enrolled` error step says `no_phone`, on a run that names the
 *   contact who replied (`pipeline_runs.contact_id`);
 * - nothing happened on the lead since: no inbound text after that run's inbound,
 *   no outbound text after it other than that run's own reply, and no drip
 *   enrolment (any status, so a drip a person cancelled is never restarted, and a
 *   second run never repeats a first run's enrolment). Checked when planning,
 *   again just before enrolling, and again right after: a reply that lands while
 *   the enrolment is written pauses the new drip and keeps the hold;
 * - the route is recoverable: nine-questions runs map the recorded answer back to
 *   its drip (and must match the recorded route); nurture runs only for routes
 *   with one fixed delay (`check_in_60`, `listed_not_selling`), since
 *   `maybe_later`'s delay (30 or 180 days) was not recorded.
 * The enrolment runs through the same `enrollNineDrip` / `enrollNurtureInDrip`
 * as dispatch, with the replier as the explicit contact, so every consent,
 * suppression, line-type and link check applies again. On success the hold is
 * cleared only if its reason still equals `drip_enroll_failed:no_phone`.
 * The enrolment is written parked (first text ~100 years out) and is armed only
 * after the post-enrol check passes; any error before arming leaves it parked,
 * so a failed check can never let it send. Armed, the first text goes out at the
 * later of its step delay and 15 minutes (nurture: the route's delay). After the
 * hold is cleared the check runs once more: a reply that slipped in while the
 * hold was still set gets the hold back and the drip paused.
 */

import { reportError } from "../src/lib/errors/report";
import { recordLeadEvent } from "../src/lib/events";
import {
  enrollNurtureInDrip,
  loadNurtureAutoDripConfig,
  NURTURE_FIRST_SEND_DELAY_DAYS,
  type NurtureDripKey,
} from "../src/lib/ai-responder/nurture-auto-drip";
import { enrollNineDrip } from "../src/lib/ai-responder/nine-questions-engine";
import { actionForNineAnswer, type NineAnswer, type NineDripName } from "../src/lib/sms-classification/nine-questions";
import { delayToDate } from "../src/lib/sequences/delays";
import { createAdminClient } from "../src/lib/supabase/admin";

const PROD_PROJECT_REF = "copflsklaefwzipsrjqz";
const BMH_ORG_ID = "00000000-0000-0000-0000-000000000bbb";
const HOLD_REASON = "drip_enroll_failed:no_phone";
const FIRST_SEND_FLOOR_MINUTES = 15;
/** A replay enrolment is written parked this far out and armed only after its checks pass. */
const PARK_DAYS = 36_500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Nurture routes whose first-text delay is a single fixed value. */
const FIXED_NURTURE_DELAY: Partial<Record<NurtureDripKey, number>> = {
  check_in_60: NURTURE_FIRST_SEND_DELAY_DAYS.check_in_60,
  listed_not_selling: NURTURE_FIRST_SEND_DELAY_DAYS.listed_not_selling,
};

type Options = { apply: boolean; only: string[] };

function parse(argv: string[]): Options {
  const o: Options = { apply: false, only: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--apply") o.apply = true;
    else if (a === "--only") {
      const v = argv[++i];
      if (!v || !UUID.test(v)) throw new Error(`--only needs a property uuid, got: ${v ?? "(nothing)"}`);
      o.only.push(v.toLowerCase());
    } else if (a === "--help" || a === "-h") {
      console.log(`Usage: tsx scripts/replay-drip-enroll-no-phone.ts [options]
  --apply          Enrol and clear the hold (default: dry run, no writes).
  --only <uuid>    Limit to these properties; repeatable.`);
      process.exit(0);
    } else throw new Error(`Unknown option: ${a}`);
  }
  return o;
}

function assertProd(): void {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) throw new Error("NEXT_PUBLIC_SUPABASE_URL must be set.");
  const ref = new URL(url).hostname.split(".")[0];
  if (ref !== PROD_PROJECT_REF) throw new Error(`Refusing to run: ${ref} is not prod ${PROD_PROJECT_REF}.`);
}

type Supabase = ReturnType<typeof createAdminClient>;

/** What "nothing happened since the failure" is measured against. */
export type Fence = { inboundAt: string; ownOutboundId: string | null; failedAt: string };

export type Plan =
  | { kind: "skip"; why: string }
  | {
      kind: "nine";
      fence: Fence;
      contactId: string;
      route: string;
      drip: NineDripName;
      skipFirstStep: boolean;
    }
  | { kind: "nurture"; fence: Fence; contactId: string; route: NurtureDripKey; delayDays: number };

type Held = { id: string; address: string | null };

async function heldLeads(supabase: Supabase, only: string[]): Promise<Held[]> {
  const out: Held[] = [];
  for (let from = 0; ; from += 500) {
    let q = supabase
      .from("properties")
      .select("id, address")
      .eq("org_id", BMH_ORG_ID)
      .eq("needs_human_attention", true)
      .eq("last_ai_escalation_reason", HOLD_REASON)
      .is("homeowner_contact_id", null)
      .order("id")
      .range(from, from + 499);
    if (only.length) q = q.in("id", only);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    for (const r of data ?? []) out.push({ id: r.id, address: r.address });
    if (!data || data.length < 500) return out;
  }
}

function detailOf(d: unknown): Record<string, unknown> {
  return d && typeof d === "object" && !Array.isArray(d) ? (d as Record<string, unknown>) : {};
}

export async function planFor(supabase: Supabase, propertyId: string): Promise<Plan> {
  // Newest run on this lead whose drip step failed.
  const { data: runs, error: runsError } = await supabase
    .from("pipeline_runs")
    .select("id, contact_id, inbound_message_id, outbound_message_id, started_at")
    .eq("org_id", BMH_ORG_ID)
    .eq("property_id", propertyId)
    .order("started_at", { ascending: false })
    .limit(20);
  if (runsError) throw new Error(runsError.message);
  for (const run of runs ?? []) {
    const { data: steps, error: stepsError } = await supabase
      .from("pipeline_run_steps")
      .select("name, result, detail, seq")
      .eq("run_id", run.id)
      .in("name", ["drip_enrolled", "nine_questions_route"])
      .order("seq", { ascending: true });
    if (stepsError) throw new Error(stepsError.message);
    const drip = (steps ?? []).filter((s) => s.name === "drip_enrolled").at(-1);
    if (!drip) continue;
    const detail = detailOf(drip.detail);
    if (drip.result !== "error" || detail.reason !== "no_phone") {
      return { kind: "skip", why: `newest drip step was ${drip.result}/${String(detail.reason ?? "-")}` };
    }
    if (!run.contact_id) return { kind: "skip", why: "run has no contact" };

    const { data: inbound, error: inboundError } = await supabase
      .from("messages")
      .select("id, created_at")
      .eq("id", run.inbound_message_id)
      .maybeSingle();
    if (inboundError) throw new Error(inboundError.message);
    if (!inbound) return { kind: "skip", why: "run's inbound message not found" };
    const fence: Fence = { inboundAt: inbound.created_at, ownOutboundId: run.outbound_message_id, failedAt: run.started_at };
    const stale = await staleReason(supabase, propertyId, fence);
    if (stale) return { kind: "skip", why: stale };

    const route = typeof detail.route === "string" ? detail.route : null;
    if (!route) return { kind: "skip", why: "no route recorded" };
    if (detail.engine === "nine_questions") {
      const routeStep = (steps ?? []).find((s) => s.name === "nine_questions_route");
      const answer = detailOf(routeStep?.detail).answer;
      if (typeof answer !== "string") return { kind: "skip", why: "nine answer not recorded" };
      const action = actionForNineAnswer(answer as NineAnswer);
      if (action.kind === "reply_and_drip" && action.drip === route) {
        return { kind: "nine", fence, contactId: run.contact_id, route, drip: action.drip, skipFirstStep: action.skipFirstStep };
      }
      if (action.kind === "drip_only" && action.drip === route) {
        return { kind: "nine", fence, contactId: run.contact_id, route, drip: action.drip, skipFirstStep: false };
      }
      return { kind: "skip", why: `answer ${answer} does not map to route ${route}` };
    }
    const delayDays = FIXED_NURTURE_DELAY[route as NurtureDripKey];
    if (delayDays === undefined) return { kind: "skip", why: `nurture route ${route}: first-text delay not recorded` };
    return { kind: "nurture", fence, contactId: run.contact_id, route: route as NurtureDripKey, delayDays };
  }
  return { kind: "skip", why: "no failed drip step found" };
}

/**
 * Why the lead is no longer the one that failed, or null. A newer reply, a text
 * someone sent, or any drip enrolment since the failure (other than the one this
 * run just wrote) is a person's call, not a replay.
 */
export async function staleReason(supabase: Supabase, propertyId: string, fence: Fence, ownEnrollmentId?: string): Promise<string | null> {
  const { count: inCount, error: inError } = await supabase
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("property_id", propertyId)
    .eq("direction", "inbound")
    .gt("created_at", fence.inboundAt);
  if (inError) throw new Error(inError.message);
  if ((inCount ?? 0) > 0) return "seller texted again after the failed run";

  let outbound = supabase
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("property_id", propertyId)
    .eq("direction", "outbound")
    .gt("created_at", fence.inboundAt);
  if (fence.ownOutboundId) outbound = outbound.neq("id", fence.ownOutboundId);
  const { count: outCount, error: outError } = await outbound;
  if (outError) throw new Error(outError.message);
  if ((outCount ?? 0) > 0) return "another text was sent to the lead after the failed run";

  let enrollments = supabase
    .from("sequence_enrollments")
    .select("id", { count: "exact", head: true })
    .eq("property_id", propertyId)
    .gte("enrolled_at", fence.failedAt);
  if (ownEnrollmentId) enrollments = enrollments.neq("id", ownEnrollmentId);
  const { count: enrCount, error: enrError } = await enrollments;
  if (enrError) throw new Error(enrError.message);
  if ((enrCount ?? 0) > 0) return "a drip was started (or cancelled) on the lead after the failed run";
  return null;
}

export async function stillHeld(supabase: Supabase, propertyId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("properties")
    .select("needs_human_attention, last_ai_escalation_reason, homeowner_contact_id")
    .eq("id", propertyId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return Boolean(data?.needs_human_attention && data.last_ai_escalation_reason === HOLD_REASON && !data.homeowner_contact_id);
}

export async function apply(supabase: Supabase, propertyId: string, plan: Exclude<Plan, { kind: "skip" }>): Promise<string> {
  if (!(await stillHeld(supabase, propertyId))) return "skipped: hold changed since the dry read";
  const staleBefore = await staleReason(supabase, propertyId, plan.fence);
  if (staleBefore) return `skipped: ${staleBefore}`;
  const enrolledAt = Date.now();
  // Born parked: nothing can be sent until the checks below pass and arm it.
  const parkedUntil = new Date(enrolledAt + PARK_DAYS * 86_400_000);
  // When the first text may go out once armed: the replay floor, or the
  // nurture route's own delay.
  const floor = new Date(enrolledAt + (plan.kind === "nurture" ? plan.delayDays * 1440 : FIRST_SEND_FLOOR_MINUTES) * 60_000);
  let result: { status: "enrolled"; enrollmentId: string } | { status: "already_enrolled" } | { status: "refused"; reason: string };
  if (plan.kind === "nine") {
    if (plan.drip === "Maybe later" && !(await loadNurtureAutoDripConfig(supabase, BMH_ORG_ID)).enabled) {
      return "skipped: nurture auto-drip switch is off";
    }
    result = await enrollNineDrip(supabase, {
      orgId: BMH_ORG_ID,
      propertyId,
      dripName: plan.drip,
      skipFirstStep: plan.skipFirstStep,
      contactId: plan.contactId,
      firstSendNotBefore: parkedUntil,
    });
  } else {
    const cfg = await loadNurtureAutoDripConfig(supabase, BMH_ORG_ID);
    if (!cfg.enabled) return "skipped: nurture auto-drip switch is off";
    result = await enrollNurtureInDrip(supabase, {
      propertyId,
      sequenceId: cfg.sequences[plan.route],
      delayDays: PARK_DAYS,
      route: plan.route,
      contactId: plan.contactId,
    });
  }
  if (result.status === "refused") return `refused: ${result.reason} (hold kept)`;
  // Nothing was enrolled before (checked above), so a live drip now is one a
  // person or another run started meanwhile: leave the hold for a person.
  if (result.status !== "enrolled") return "skipped: a drip went live meanwhile (hold kept)";
  const enrollmentId = result.enrollmentId;

  try {
    // A reply that landed while the enrolment was written may have run its
    // pause before the row existed.
    const staleAfter = await staleReason(supabase, propertyId, plan.fence, enrollmentId);
    if (staleAfter) {
      await pauseOwn(supabase, enrollmentId, floor);
      return `enrolled parked then paused (${staleAfter}); hold kept`;
    }
    const armedStatus = await arm(supabase, enrollmentId, floor, enrolledAt);
    if (armedStatus !== "active") return `enrolled, ${armedStatus ?? "not armed"} meanwhile; hold kept`;
  } catch (e) {
    // Fail closed: the enrolment stays parked (no text for PARK_DAYS). Best
    // effort, also pause it with its real floor so a person who resumes it
    // later gets a working drip.
    await pauseOwn(supabase, enrollmentId, floor).catch(() => undefined);
    return `ENROLLED BUT LEFT PARKED (${e instanceof Error ? e.message : String(e)}): enrolment ${enrollmentId} sends nothing; hold kept, a person must review`;
  }

  const now = new Date().toISOString();
  const { data: cleared, error } = await supabase
    .from("properties")
    .update({ needs_human_attention: false, last_ai_escalation_reason: null, last_ai_escalation_at: null, updated_at: now })
    .eq("id", propertyId)
    .eq("needs_human_attention", true)
    .eq("last_ai_escalation_reason", HOLD_REASON)
    .select("id");
  if (error) return `enrolled; hold NOT cleared: ${error.message}`;
  if (!cleared?.length) return "enrolled; hold changed meanwhile, left as is";

  // A reply stored before the clear found the hold still set, so its dispatch
  // left it for a person: put the hold back and stop the drip. A reply stored
  // after this check runs its normal dispatch against the cleared lead.
  let staleAfterClear: string | null;
  try {
    staleAfterClear = await staleReason(supabase, propertyId, plan.fence, enrollmentId);
  } catch (e) {
    staleAfterClear = `freshness unreadable after clearing: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (staleAfterClear) {
    const restored = await restoreHold(supabase, propertyId);
    const paused = await pauseOwn(supabase, enrollmentId).then(() => "paused", (e: unknown) => `NOT paused: ${e instanceof Error ? e.message : String(e)}`);
    return `enrolled then ${paused}, hold ${restored ? "restored" : "NOT restored"} (${staleAfterClear})`;
  }
  try {
    await recordLeadEvent({
      propertyId,
      actorType: "system",
      eventType: "ai_escalation_cleared",
      payload: { from: true, to: false, via: "replay_drip_enroll_no_phone", reason: HOLD_REASON },
    });
  } catch (e) {
    reportError(e, { tags: { surface: "replay_drip_enroll_no_phone_event" }, extra: { propertyId } });
  }
  return "enrolled; hold cleared";
}

/** Pause the replay's own enrolment; `floor` also un-parks it so a later resume can send. */
async function pauseOwn(supabase: Supabase, enrollmentId: string, floor?: Date): Promise<void> {
  const { error } = await supabase
    .from("sequence_enrollments")
    .update({
      status: "paused",
      pause_reason: "inbound_reply",
      ...(floor ? { first_send_not_before: floor.toISOString() } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", enrollmentId)
    .eq("status", "active");
  if (error) throw new Error(`pause failed: ${error.message}`);
}

/**
 * Un-park the replay's own enrolment: the first text at the later of `floor`
 * and its starting step's own delay (what `enrollLead` would have set).
 * Returns the row's status after the update (null if the row was not parked).
 */
async function arm(supabase: Supabase, enrollmentId: string, floor: Date, enrolledAt: number): Promise<string | null> {
  const { data: row, error: rowError } = await supabase
    .from("sequence_enrollments")
    .select("sequence_id, current_step_index")
    .eq("id", enrollmentId)
    .maybeSingle();
  if (rowError) throw new Error(rowError.message);
  if (!row) throw new Error("enrolment row not found");
  const { data: step, error: stepError } = await supabase
    .from("sequence_steps")
    .select("delay_after_previous_minutes")
    .eq("sequence_id", row.sequence_id)
    .eq("step_index", row.current_step_index)
    .maybeSingle();
  if (stepError) throw new Error(stepError.message);
  if (!step) throw new Error("starting step not found");
  const stepAt = delayToDate(step.delay_after_previous_minutes, new Date(enrolledAt));
  const runAt = stepAt.getTime() > floor.getTime() ? stepAt : floor;
  const { data: armed, error } = await supabase
    .from("sequence_enrollments")
    .update({ first_send_not_before: floor.toISOString(), next_run_at: runAt.toISOString(), updated_at: new Date().toISOString() })
    .eq("id", enrollmentId)
    .gt("first_send_not_before", new Date(enrolledAt + (PARK_DAYS / 2) * 86_400_000).toISOString())
    .select("status");
  if (error) throw new Error(`arm failed: ${error.message}`);
  return armed?.[0]?.status ?? null;
}

async function restoreHold(supabase: Supabase, propertyId: string): Promise<boolean> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("properties")
    .update({ needs_human_attention: true, last_ai_escalation_reason: HOLD_REASON, last_ai_escalation_at: now, updated_at: now })
    .eq("id", propertyId)
    .eq("needs_human_attention", false)
    .select("id");
  return !error && Boolean(data?.length);
}

async function main(): Promise<void> {
  const opts = parse(process.argv.slice(2));
  assertProd();
  const supabase = createAdminClient();
  const held = await heldLeads(supabase, opts.only);
  console.log(`${opts.apply ? "APPLY" : "DRY RUN"}: ${held.length} lead(s) held ${HOLD_REASON} with no saved homeowner.\n`);
  const tally: Record<string, number> = {};
  for (const lead of held) {
    const plan = await planFor(supabase, lead.id);
    const where = `${lead.address ?? "(no address)"} | ${lead.id}`;
    if (plan.kind === "skip") {
      tally.skipped = (tally.skipped ?? 0) + 1;
      console.log(`  SKIP  ${where} | ${plan.why}`);
      continue;
    }
    const route = plan.kind === "nine" ? `nine:${plan.drip}${plan.skipFirstStep ? " (from text 2)" : ""}` : `nurture:${plan.route} +${plan.delayDays}d`;
    const outcome = opts.apply ? await apply(supabase, lead.id, plan) : "would enrol";
    const key = outcome.split(/[;:]/)[0]!;
    tally[key] = (tally[key] ?? 0) + 1;
    console.log(`  ${opts.apply ? "DONE" : "PLAN"}  ${where} | contact ${plan.contactId} | ${route} | ${outcome}`);
  }
  console.log(`\nTotals: ${JSON.stringify(tally)}`);
}

if (process.argv[1]?.endsWith("replay-drip-enroll-no-phone.ts")) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
