import { existsSync, readFileSync } from 'node:fs';
import type { Client } from 'pg';

// The My Leads migrations create tables, columns and indexes without `if not exists` (production
// DDL stays strict). In CI the disposable database is already fully migrated, locally it may not
// be, so the integration suites call applyMyLeadsChain() inside their rolled-back transaction: it
// removes every chain migration that is present (newest first, with the migrations' own rollback
// twins), then applies the requested ones in order. Both starting states end identically, and the
// caller rolls everything back. Entries whose migration file is not in the checkout (a later
// branch in the stack) are ignored, so each branch only ever sees its own ancestry.
const root = new URL('../../supabase/', import.meta.url);

export const MIGRATIONS = {
  tools: 'migrations/20261005100000_my_leads_housekeeping_tools.sql',
  reassign: 'migrations/20261005100100_my_leads_housekeeping_reassign.sql',
  outcome: 'migrations/20261005110000_acquisition_attempt_outcome_voicemail_not_logged.sql',
} as const;
export const ROLLBACKS = {
  tools: 'rollbacks/20261005100000_my_leads_housekeeping_tools.sql',
  reassign: 'rollbacks/20261005100100_my_leads_housekeeping_reassign.sql',
  outcome: 'rollbacks/20261005110000_acquisition_attempt_outcome_voicemail_not_logged.sql',
} as const;

export function readSql(relative: string): string {
  return readFileSync(new URL(relative, root), 'utf8');
}

export function stripTransaction(relative: string): string {
  const sql = readSql(relative);
  if (!/^[\s\S]*?\bbegin;\s*/im.test(sql) || !/\s*commit;\s*$/i.test(sql)) throw new Error(`${relative}: transaction wrapper changed`);
  return sql.replace(/^begin;\s*/im, '').replace(/\s*commit;\s*$/i, '');
}

const q = (sql: string) => `select (${sql}) as present`;
const proc = (name: string) => `exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = '${name}')`;
const procUses = (name: string, token: string) =>
  `coalesce((select bool_or(p.prosrc like '%${token}%') from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = '${name}'), false)`;
const column = (table: string, col: string) =>
  `exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = '${table}' and column_name = '${col}')`;

// Canonical stack order. `present` is a read-only probe of one object the migration creates or
// rewrites, so a database can be classified without guessing from the migration list.
const CHAIN = [
  { key: 'tools', file: '20261005100000_my_leads_housekeeping_tools', present: "to_regclass('public.my_leads_housekeeping_runs') is not null" },
  { key: 'reassign', file: '20261005100100_my_leads_housekeeping_reassign', present: proc('fn_my_leads_housekeeping_reassign') },
  { key: 'outcome', file: '20261005110000_acquisition_attempt_outcome_voicemail_not_logged',
    present: "exists (select 1 from pg_constraint where conrelid = 'public.acquisition_attempts'::regclass and conname = 'acquisition_attempts_outcome_check' and pg_get_constraintdef(oid) like '%not_logged%')" },
  { key: 'schema', file: '20261005120000_next_step_schema', present: "to_regclass('public.my_leads_feature_flags') is not null" },
  { key: 'createFn', file: '20261005120500_fn_create_next_step', present: proc('fn_create_next_step') },
  { key: 'readModel', file: '20261005121000_next_step_read_model', present: procUses('my_leads_queue_rows_for', 'next_step_kind') },
  { key: 'modeAware', file: '20261005121200_next_step_mode_aware_lifecycle', present: procUses('fn_reschedule_appointment_base_20260816', 'phone_no_calendar') },
  { key: 'relabel', file: '20261005121500_next_step_relabel_functions', present: proc('fn_set_next_step_mode') },
  { key: 'reassignSources', file: '20261005122000_my_leads_housekeeping_reassign_sources',
    present: "exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'fn_my_leads_housekeeping_reassign' and p.pronargs = 7)" },
  { key: 'offerChain', file: '20261005130000_offer_follow_up_chain', present: column('acquisition_offers', 'follow_up_calendar_chain_id') },
  { key: 'setNextAction', file: '20261005130100_set_lead_next_action_next_step', present: procUses('set_lead_next_action', 'fn_create_next_step') },
  { key: 'jitterSoftphone', file: '20261005130200_jitter_softphone_callback_next_step', present: procUses('jitter_writeback_call_activity_softphone', 'fn_create_next_step') },
  { key: 'jitterWriteback', file: '20261005130300_jitter_writeback_callback_next_step', present: procUses('jitter_writeback_call_activity_before_metrics', 'fn_create_next_step') },
  { key: 'normaComplete', file: '20261005130400_norma_complete_call_next_step', present: procUses('fn_norma_complete_call', 'fn_create_next_step') },
  { key: 'normaReview', file: '20261005130500_norma_needs_review_next_step', present: procUses('fn_norma_mark_needs_review', 'fn_create_next_step') },
  { key: 'reassignQueueScope', file: '20261005140000_my_leads_housekeeping_reassign_queue_scope',
    present: procUses('my_leads_housekeeping_reassign_scope', 'acquisition_queue_states') },
  { key: 'callNext', file: '20261005150000_my_leads_call_next', present: "to_regclass('public.my_leads_strip_overrides') is not null" },
  { key: 'postCall', file: '20261005160000_post_call_prompt_support', present: column('lead_notes', 'idempotency_key') },
  { key: 'sellerReminders', file: '20261005170000_seller_appointment_reminders', present: "to_regclass('public.seller_appointment_reminders') is not null" },
  { key: 'linkCapture', file: '20261005180000_dialpad_hangup_link_capture', present: proc('dialpad_cti_hangup_links') },
  // Phase 2 data plane.
  { key: 'ledgerKeys', file: '20261006100000_dialpad_ledger_keys_native_columns', present: proc('dialpad_cti_is_ledger_key') },
  { key: 'intentTimeout', file: '20261006100100_dialpad_intent_timeout', present: proc('fn_fail_stale_dialpad_intents') },
  { key: 'phoneNumbers', file: '20261006100200_contact_phone_numbers', present: "to_regclass('public.contact_phone_numbers') is not null" },
  { key: 'nativeMatching', file: '20261006100300_dialpad_native_matching', present: proc('dialpad_cti_native_resolve') },
  { key: 'assignToLead', file: '20261006100400_dialpad_native_assign_to_lead', present: proc('fn_assign_native_call_to_lead') },
  { key: 'artifactFetches', file: '20261006100500_dialpad_artifact_fetches', present: "to_regclass('public.dialpad_call_artifact_fetches') is not null" },
  { key: 'replayLocation', file: '20261006111000_fn_create_next_step_replay_location', present: procUses('fn_create_next_step', 'v_existing.location') },
  { key: 'leadComps', file: '20261007100000_lead_comps_foundation', present: "to_regclass('public.lead_comps') is not null" },
  // Phase 2 UI.
  { key: 'ackPrompts', file: '20261007150000_call_prompt_acknowledgement', present: proc('fn_list_unacknowledged_call_prompts') },
  { key: 'apiDial', file: '20261007150100_dialpad_api_dial_support', present: column('dialpad_org_connections', 'dial_endpoint') },
  { key: 'redaction', file: '20261007150200_dialpad_unmatched_event_redaction', present: proc('fn_redact_dialpad_unmatched_events') },
  { key: 'callbacksDue', file: '20261007150300_my_leads_callbacks_due', present: proc('fn_my_leads_callbacks_due') },
  { key: 'contractDefaults', file: '20261007160000_acquisition_contract_defaults', present: "to_regclass('public.acquisition_contract_settings') is not null" },
  { key: 'offerProjections', file: '20261007170000_acquisition_offer_projections', present: "to_regclass('public.acquisition_offer_projections') is not null" },
  // P1a-retire (merged last): rejects new follow_up/callback task rows. Its rollback twin drops the trigger, so
  // suites that seed legacy rows get a chain without it whatever the database held before.
  { key: 'retire', file: '20261008100000_retire_follow_up_callback_types', present: "exists (select 1 from pg_trigger where tgname = 'trg_tasks_reject_retired_types' and not tgisinternal)" },
] as const;

export type ChainKey = (typeof CHAIN)[number]['key'];
const migrationPath = (file: string) => `migrations/${file}.sql`;
const rollbackPath = (file: string) => `rollbacks/${file}.sql`;
const inCheckout = (file: string) => existsSync(new URL(migrationPath(file), root));

/** Every chain key whose migration file exists in this checkout, in stack order. */
export function chainKeys(): ChainKey[] {
  return CHAIN.filter((entry) => inCheckout(entry.file)).map((entry) => entry.key);
}

/** The checkout's keys from the start of the stack up to and including `key`. */
export function chainThrough(key: ChainKey): ChainKey[] {
  const keys = chainKeys();
  const at = keys.indexOf(key);
  if (at < 0) throw new Error(`${key}: migration is not in this checkout`);
  return keys.slice(0, at + 1);
}

/**
 * Leaves the connection's open transaction with exactly the requested My Leads migrations applied,
 * in the order given (and none of the others), whatever the database held before. Call it right after `begin`.
 */
export async function applyMyLeadsChain(db: Client, steps: readonly (ChainKey | { sql: string })[]): Promise<void> {
  const known = CHAIN.filter((entry) => inCheckout(entry.file));
  for (const step of steps) {
    if (typeof step === 'string' && !known.some((entry) => entry.key === step)) throw new Error(`${step}: migration is not in this checkout`);
  }
  const present: boolean[] = [];
  for (const entry of known) present.push((await db.query(q(entry.present))).rows[0].present === true);
  // A stack applies in order, so what is present must be a prefix of the stack. Anything else is a
  // half-migrated database and rolling it back blindly could corrupt it.
  const firstAbsent = present.indexOf(false);
  if (firstAbsent >= 0 && present.slice(firstAbsent).some(Boolean)) {
    throw new Error(`My Leads migrations are partly applied (${known.map((e, i) => `${e.key}=${present[i]}`).join(', ')}); reset the test database`);
  }
  for (let i = known.length - 1; i >= 0; i--) {
    if (present[i]) await db.query(stripTransaction(rollbackPath(known[i].file)));
  }
  // Applied in the caller's order; `{ sql }` steps run raw SQL (a baseline migration outside the chain).
  for (const step of steps) {
    if (typeof step !== 'string') await db.query(step.sql);
    else await db.query(stripTransaction(migrationPath(known.find((entry) => entry.key === step)!.file)));
  }
}

export async function applyP1e(db: Client, through: keyof typeof MIGRATIONS): Promise<void> {
  const order = ['tools', 'reassign', 'outcome'] as const;
  await applyMyLeadsChain(db, order.slice(0, order.indexOf(through) + 1));
}
