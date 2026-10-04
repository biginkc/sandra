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
  | "lead_comps";

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
  // P3a: comps enqueue/claim/finish and the cap ledger; `monthly_call_cap` stands for the settings row.
  lead_comps: {
    functions: [
      "public.fn_enqueue_comp_fetch(uuid,uuid,text,uuid)",
      "public.fn_claim_comp_fetches(integer)",
      "public.fn_finish_comp_fetch(uuid,text,integer,text,uuid)",
    ],
    columns: ["lead_comps.as_is_value", "org_comp_settings.monthly_call_cap", "lead_valuation_inputs.arv"],
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
