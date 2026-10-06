import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Deploy-before-migration guard. Vercel serves new code about a minute before
 * its migration applies, so a changed EXISTING action asks `schemaReady` and
 * keeps its legacy code path until the functions and columns it calls exist.
 * Each later sub-PR appends its own feature to `SchemaFeature` and
 * `REQUIREMENTS`.
 */
export type SchemaFeature =
  | "next_step_write"
  | "call_next"
  | "lead_note_idempotency"
  | "post_call_support"
  | "seller_reminders"
  | "artifact_fetch"
  | "intent_timeout"
  | "lead_comps"
  | "api_dial"
  | "ack_prompts"
  | "callbacks_due"
  | "event_redaction"
  | "contract_defaults"
  | "offer_projection"
  | "call_facts"
  | "post_call_extras_proof"
  | "dialpad_call_audio";

export type SchemaRequirement = {
  /** `public.fn_name(argtype,argtype)` regprocedure strings. */
  functions: readonly string[];
  /** `table.column`, public schema. */
  columns: readonly string[];
};

export const REQUIREMENTS: Record<SchemaFeature, SchemaRequirement> = {
  next_step_write: {
    functions: [
      "public.fn_create_next_step(uuid,uuid,uuid,text,text,timestamptz,uuid,uuid,text,timestamptz,text,text,text,uuid,uuid,text,boolean,boolean)",
    ],
    columns: ["tasks.mode", "tasks.location", "tasks.next_step_kind"],
  },
  // P1b: the Call next strip reads the ranking RPCs and, through them, the offer chain column.
  call_next: {
    functions: [
      "public.fn_get_my_leads_call_next(uuid,uuid,integer)",
      "public.fn_set_my_leads_strip_override(uuid,uuid,uuid,text)",
      "public.fn_get_my_leads_triage(uuid,uuid,integer,integer,timestamptz,uuid)",
      "public.my_leads_call_next_rows(uuid,uuid,timestamptz)",
    ],
    columns: ["acquisition_offers.follow_up_calendar_chain_id", "tasks.next_step_kind"],
  },
  // P1c: the idempotent note insert needs the column (the unique index lands in the same migration).
  lead_note_idempotency: {
    functions: [],
    columns: ["lead_notes.idempotency_key"],
  },
  // P1c: the post-call prompt needs the widened voicemail validators, the richer call references
  // and the attempt note. They ship in one migration whose only catalog-visible marker is the
  // lead_notes column, so that column stands for all of them.
  post_call_support: {
    functions: ["public.fn_get_acquisition_call_references(uuid,uuid,uuid)"],
    columns: ["lead_notes.idempotency_key", "acquisition_attempts.note"],
  },
  // P1c-2: the seller reminder job calls the three outbox functions and reads the on/off switch.
  seller_reminders: {
    functions: [
      "public.fn_schedule_seller_reminders(interval,integer,uuid[])",
      "public.fn_claim_seller_reminders(integer,uuid[])",
      "public.fn_finish_seller_reminder(uuid,uuid,text,text,uuid,timestamptz,uuid)",
    ],
    columns: ["seller_reminder_settings.enabled", "seller_appointment_reminders.send_key"],
  },
  // P2 data plane: the Dialpad transcript / Recap fetch job claims and records through these functions.
  artifact_fetch: {
    functions: [
      "public.fn_claim_dialpad_artifact_fetches(integer,integer,text[])",
      "public.fn_record_dialpad_artifact_result(uuid,text,text,text,text,text)",
      "public.fn_resolve_dialpad_recording_links(integer)",
    ],
    columns: ["dialpad_call_artifact_fetches.state", "my_leads_feature_flags.artifact_fetch"],
  },
  // P2 data plane: the event sweep marks stale dials through the timeout function and its marker column.
  intent_timeout: {
    functions: ["public.fn_fail_stale_dialpad_intents(integer,integer)"],
    columns: ["dialpad_call_intents.failed_at"],
  },
  // P3a: comps enqueue/claim/finish and the cap ledger; `monthly_call_cap` stands for the settings row.
  lead_comps: {
    functions: [
      "public.fn_enqueue_comp_fetch(uuid,uuid,text,uuid)",
      "public.fn_claim_comp_fetches(integer,uuid)",
      "public.fn_finish_comp_fetch(uuid,text,integer,text,uuid)",
    ],
    columns: ["lead_comps.as_is_value", "org_comp_settings.monthly_call_cap", "lead_valuation_inputs.arv"],
  },
  // P2 UI 2.7: the server-side dialer needs the patched authorize release (dialpadUserId), the slot pre-check and the two connection columns.
  api_dial: {
    functions: ["public.fn_dialpad_call_slots(uuid,uuid,uuid,uuid)", "public.fn_authorize_dialpad_dispatch(uuid,uuid,uuid)"],
    columns: ["dialpad_org_connections.dial_endpoint", "dialpad_org_connections.dial_api_key_ref", "my_leads_feature_flags.click_to_dial"],
  },
  // P2 UI 2.6: the poll reads unacknowledged prompts and the auto-open acknowledges them.
  ack_prompts: {
    functions: ["public.fn_list_unacknowledged_call_prompts(uuid,integer,timestamptz,uuid,interval)", "public.fn_acknowledge_call_prompt(uuid,uuid,text)"],
    columns: ["acquisition_attempts.prompt_acknowledged_at", "my_leads_feature_flags.auto_prompt"],
  },
  // P2 UI 2.8: the callback-due alert.
  callbacks_due: {
    functions: ["public.fn_my_leads_callbacks_due(uuid,interval,interval)"],
    columns: ["tasks.next_step_kind", "my_leads_feature_flags.callback_alert"],
  },
  // P2 UI 2.10: the event sweep redacts unmatched payloads through this function.
  event_redaction: {
    functions: ["public.fn_redact_dialpad_unmatched_events(interval,integer)"],
    columns: ["dialpad_call_events.redacted_at"],
  },
  // P3c: contract defaults tables (title companies, buyer entities, settings).
  contract_defaults: {
    functions: [],
    columns: ["acquisition_contract_settings.earnest_money_cents", "acquisition_contract_title_companies.closing_agent_name", "acquisition_contract_buyer_entities.name"],
  },
  // P3c offer projection (§3.6): the card and the sweep stay disabled until every function they call exists.
  offer_projection: {
    functions: [
      "public.fn_project_acquisition_offer(uuid)",
      "public.fn_create_offer_projection(uuid,uuid,uuid,uuid,text,text,jsonb,bigint,date,text,text,text)",
      "public.fn_abandon_offer_projection(uuid)",
      "public.fn_offer_projection_repair()",
      "public.fn_offer_projection_due(integer)",
      "public.fn_retry_offer_projection(uuid,uuid,text)",
      "public.fn_supersede_offer_and_log(uuid,uuid,uuid)",
      "public.fn_list_offer_conflicts(uuid,uuid,uuid)",
    ],
    columns: ["acquisition_offer_projections.send_payload"],
  },
  // P3c call facts (§3.12): the sweep, the chips and their accept/dismiss actions.
  call_facts: {
    functions: [
      "public.fn_claim_call_facts(integer,integer,integer)",
      "public.fn_call_known_names(uuid,uuid)",
      "public.fn_complete_call_facts(uuid,uuid,jsonb,text,text)",
      "public.fn_accept_call_fact(uuid,uuid,text,text)",
      "public.fn_dismiss_call_facts(uuid,uuid)",
      "public.fn_unaccept_call_fact(uuid,uuid,text)",
    ],
    columns: ["lead_call_facts.processing_state"],
  },
  // PR #823: the post-call note and appointment are written only behind this proof function.
  post_call_extras_proof: {
    functions: ["public.fn_post_call_extras_proof(uuid,uuid,uuid,uuid)"],
    columns: [],
  },
  // Dialpad call audio: the recording worker route stays disabled until every table, flag column and function it
  // calls exists. (The private bucket is checked separately by the route; this probe sees only the public schema.)
  dialpad_call_audio: {
    functions: [
      "public.fn_dpa_worker_take(uuid)",
      "public.fn_dpa_worker_release(uuid,timestamptz,timestamptz)",
      "public.fn_dpa_worker_block(uuid,timestamptz)",
      "public.fn_dpa_queue(uuid,integer)",
      "public.fn_dpa_discovery_result(uuid,uuid,text,text,bigint,text,text)",
      "public.fn_dpa_requeue_denied(uuid,uuid,text)",
      "public.fn_dpa_attempt_begin(uuid,uuid)",
      "public.fn_dpa_attempt_set(uuid,uuid,text,text,text,text,text,text)",
      "public.fn_dpa_resolve_ambiguous(uuid,text)",
      "public.fn_dpa_audio_fail(uuid,uuid,text,text,text)",
      "public.fn_dpa_mark_uploading(uuid,uuid,text,bigint,bigint)",
      "public.fn_dpa_register_stored(uuid,uuid,text,bigint,text,bigint)",
      "public.fn_dialpad_audio_authorize(uuid,uuid,uuid)",
      "public.fn_dialpad_audio_for_service(uuid,uuid,text)",
    ],
    columns: [
      "dialpad_call_audio.state",
      "dialpad_call_audio.upload_expected_sha256",
      "dialpad_call_audio.upload_expected_size",
      "dialpad_share_link_attempts.reason",
      "dialpad_share_link_attempts.state",
      "dialpad_recording_worker.recording_blocked_until",
      "dialpad_audio_access_log.consumer",
      "my_leads_feature_flags.recording_download",
      "my_leads_feature_flags.recording_download_canary_call_ids",
      "my_leads_feature_flags.audio_consumers",
    ],
  },
};

/** A false answer is re-checked after this long so a landing migration is picked up without a redeploy. */
export const NOT_READY_TTL_MS = 30_000;

type ProbeClient = {
  rpc(
    fn: "fn_my_leads_schema_probe",
    args: { p_functions: string[]; p_columns: string[] },
  ): PromiseLike<{
    data: unknown;
    error: { message?: string } | null;
  }>;
};

type CacheEntry = { ready: boolean; checkedAt: number };

const cache = new Map<SchemaFeature, CacheEntry>();
let now: () => number = () => Date.now();

/** Test hooks. */
export function clearSchemaReadyCache(): void {
  cache.clear();
}
export function setSchemaReadyClock(clock: (() => number) | null): void {
  now = clock ?? (() => Date.now());
}

function allTrue(map: unknown, keys: readonly string[]): boolean {
  if (!map || typeof map !== "object") return false;
  const record = map as Record<string, unknown>;
  return keys.every((key) => record[key] === true);
}

async function probe(feature: SchemaFeature): Promise<boolean> {
  const req = REQUIREMENTS[feature];
  try {
    const client = createAdminClient() as unknown as ProbeClient;
    const { data, error } = await client.rpc("fn_my_leads_schema_probe", {
      p_functions: [...req.functions],
      p_columns: [...req.columns],
    });
    if (error || !data || typeof data !== "object") return false;
    const result = data as { functions?: unknown; columns?: unknown };
    return (
      allTrue(result.functions, req.functions) &&
      allTrue(result.columns, req.columns)
    );
  } catch {
    return false;
  }
}

/**
 * True only when every function and column the feature's code path calls
 * exists. `true` is cached for the life of the process, `false` for 30 s. An
 * unavailable probe RPC, an error, or a throw is `false`.
 */
export async function schemaReady(feature: SchemaFeature): Promise<boolean> {
  const hit = cache.get(feature);
  if (hit && (hit.ready || now() - hit.checkedAt < NOT_READY_TTL_MS)) {
    return hit.ready;
  }
  const ready = await probe(feature);
  cache.set(feature, { ready, checkedAt: now() });
  return ready;
}
