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
 *     npx tsx scripts/replay-drip-enroll-no-phone.ts [--apply] [--only <propertyId>]...
 *
 * What a lead needs to be replayed (anything else is listed as skipped):
 * - still flagged, reason exactly `drip_enroll_failed:no_phone`, no saved homeowner;
 * - its newest `drip_enrolled` error step says `no_phone`, on a run that names the
 *   contact who replied (`pipeline_runs.contact_id`);
 * - no inbound text on the lead after that run's inbound, and no outbound text
 *   after it other than that run's own reply (a newer reply, or a rep already
 *   texting, is a person's call, not a replay);
 * - the route is recoverable: nine-questions runs map the recorded answer back to
 *   its drip (and must match the recorded route); nurture runs only for routes
 *   with one fixed delay (`check_in_60`, `listed_not_selling`), since
 *   `maybe_later`'s delay (30 or 180 days) was not recorded.
 * The enrolment runs through the same `enrollNineDrip` / `enrollNurtureInDrip`
 * as dispatch, with the replier as the explicit contact, so every consent,
 * suppression, line-type and link check applies again. On success the hold is
 * cleared only if its reason still equals `drip_enroll_failed:no_phone`.
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
import { createAdminClient } from "../src/lib/supabase/admin";

const PROD_PROJECT_REF = "copflsklaefwzipsrjqz";
const BMH_ORG_ID = "00000000-0000-0000-0000-000000000bbb";
const HOLD_REASON = "drip_enroll_failed:no_phone";
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

type Plan =
  | { kind: "skip"; why: string }
  | {
      kind: "nine";
      contactId: string;
      route: string;
      drip: NineDripName;
      skipFirstStep: boolean;
    }
  | { kind: "nurture"; contactId: string; route: NurtureDripKey; delayDays: number };

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

async function planFor(supabase: Supabase, propertyId: string): Promise<Plan> {
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

    // A newer reply on the lead belongs to a person.
    const { data: inbound, error: inboundError } = await supabase
      .from("messages")
      .select("id, created_at")
      .eq("id", run.inbound_message_id)
      .maybeSingle();
    if (inboundError) throw new Error(inboundError.message);
    if (!inbound) return { kind: "skip", why: "run's inbound message not found" };
    const { count, error: newerError } = await supabase
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("property_id", propertyId)
      .eq("direction", "inbound")
      .gt("created_at", inbound.created_at);
    if (newerError) throw new Error(newerError.message);
    if ((count ?? 0) > 0) return { kind: "skip", why: "seller texted again after the failed run" };
    // So does any text we sent after it other than this run's own reply (a rep
    // texting from the lead page, a campaign): a drip would land on top of it.
    let outbound = supabase
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("property_id", propertyId)
      .eq("direction", "outbound")
      .gt("created_at", inbound.created_at);
    if (run.outbound_message_id) outbound = outbound.neq("id", run.outbound_message_id);
    const { count: outCount, error: outError } = await outbound;
    if (outError) throw new Error(outError.message);
    if ((outCount ?? 0) > 0) return { kind: "skip", why: "another text was sent to the lead after the failed run" };

    const route = typeof detail.route === "string" ? detail.route : null;
    if (!route) return { kind: "skip", why: "no route recorded" };
    if (detail.engine === "nine_questions") {
      const routeStep = (steps ?? []).find((s) => s.name === "nine_questions_route");
      const answer = detailOf(routeStep?.detail).answer;
      if (typeof answer !== "string") return { kind: "skip", why: "nine answer not recorded" };
      const action = actionForNineAnswer(answer as NineAnswer);
      if (action.kind === "reply_and_drip" && action.drip === route) {
        return { kind: "nine", contactId: run.contact_id, route, drip: action.drip, skipFirstStep: action.skipFirstStep };
      }
      if (action.kind === "drip_only" && action.drip === route) {
        return { kind: "nine", contactId: run.contact_id, route, drip: action.drip, skipFirstStep: false };
      }
      return { kind: "skip", why: `answer ${answer} does not map to route ${route}` };
    }
    const delayDays = FIXED_NURTURE_DELAY[route as NurtureDripKey];
    if (delayDays === undefined) return { kind: "skip", why: `nurture route ${route}: first-text delay not recorded` };
    return { kind: "nurture", contactId: run.contact_id, route: route as NurtureDripKey, delayDays };
  }
  return { kind: "skip", why: "no failed drip step found" };
}

async function stillHeld(supabase: Supabase, propertyId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("properties")
    .select("needs_human_attention, last_ai_escalation_reason, homeowner_contact_id")
    .eq("id", propertyId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return Boolean(data?.needs_human_attention && data.last_ai_escalation_reason === HOLD_REASON && !data.homeowner_contact_id);
}

async function apply(supabase: Supabase, propertyId: string, plan: Exclude<Plan, { kind: "skip" }>): Promise<string> {
  if (!(await stillHeld(supabase, propertyId))) return "skipped: hold changed since the dry read";
  let result: { status: "enrolled" | "already_enrolled" } | { status: "refused"; reason: string };
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
    });
  } else {
    const cfg = await loadNurtureAutoDripConfig(supabase, BMH_ORG_ID);
    if (!cfg.enabled) return "skipped: nurture auto-drip switch is off";
    result = await enrollNurtureInDrip(supabase, {
      propertyId,
      sequenceId: cfg.sequences[plan.route],
      delayDays: plan.delayDays,
      route: plan.route,
      contactId: plan.contactId,
    });
  }
  if (result.status === "refused") return `refused: ${result.reason} (hold kept)`;

  const now = new Date().toISOString();
  const { data: cleared, error } = await supabase
    .from("properties")
    .update({ needs_human_attention: false, last_ai_escalation_reason: null, last_ai_escalation_at: null, updated_at: now })
    .eq("id", propertyId)
    .eq("needs_human_attention", true)
    .eq("last_ai_escalation_reason", HOLD_REASON)
    .select("id");
  if (error) return `${result.status}; hold NOT cleared: ${error.message}`;
  if (!cleared?.length) return `${result.status}; hold changed meanwhile, left as is`;
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
  return `${result.status}; hold cleared`;
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

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
