import { readFileSync } from "node:fs";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * 20261021130000: deterministic conflict raises must not use SQLSTATE 40001. PostgREST 14
 * retries 40001 forever and these checks fail the same way on every re-run (follow-up to
 * 20261021120000). Proves, against a stack with the migration applied: each changed function
 * raises only its dedicated code the reviewed number of times, no '40001' remains in them, the
 * functions left on 40001 on purpose are untouched, and the rollback restores 40001.
 * Per-test transaction, rolled back. Isolated local stack only (vitest.local-integration.config.ts).
 */
const db = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
const CHANGED: ReadonlyArray<[string, string, number]> = [
  ["fn_apply_and_record_ai_disposition_review_correction", "JDC01", 9],
  ["fn_apply_and_record_jev_lead_decision_correction", "JDC01", 6],
  ["fn_correct_ai_disposition_review", "JDC01", 6],
  ["fn_correct_jev_lead_decision", "JDC01", 7],
  ["fn_set_jev_outcome_threshold", "JDC01", 2],
  ["fn_set_template_auto_send_approval", "JDC01", 1],
  ["fn_undo_jev_action", "JDC01", 5],
  ["begin_definitive_esign_template_provider_create_retry", "ESG01", 1],
  ["claim_esign_template_provider_create", "ESG01", 1],
  ["finalize_esign_template", "ESG01", 2],
  ["mark_stale_esign_template_provider_create_unknown", "ESG01", 1],
  ["publish_esign_template_edit_revision", "ESG01", 4],
  ["record_definitive_esign_template_provider_create_failure", "ESG01", 1],
  ["soft_delete_esign_template", "ESG01", 1],
  ["fn_append_dialpad_recording_timing", "DPR01", 3],
  ["fn_finalize_dialpad_recording_provider_window", "DPR01", 1],
  ["fn_finalize_dialpad_recording_shadow", "DPR01", 1],
  ["fn_finish_dialpad_recording_timing", "DPR01", 1],
  ["fn_mark_dialpad_recording_eof", "DPR01", 3],
  ["fn_mint_dialpad_recording_ingest_grant", "DPR01", 1],
  ["fn_mint_dialpad_recording_next_epoch", "DPR01", 1],
  ["fn_record_dialpad_recording_chunk", "DPR01", 5],
  ["fn_record_dialpad_recording_pcm_progress", "DPR01", 2],
  ["fn_record_dialpad_recording_vad_ranges", "DPR01", 1],
  ["fn_register_dialpad_recording_result", "DPR01", 1],
  ["fn_prepare_dialpad_call_intent", "DPC01", 1],
  ["fn_assert_rep_sms_obligation_dispatch", "RSM01", 1],
  ["fn_claim_rep_sms_delivery", "RSM01", 2],
  ["fn_claim_rep_sms_delivery_with_composition", "RSM01", 2],
  ["fn_owner_correct_rep_sms_obligation", "RSM01", 2],
  ["fn_record_rep_sms_delivery_result", "RSM01", 4],
  ["fn_record_rep_sms_obligation_result", "RSM01", 2],
  ["rep_sms_obligation_transition_guard", "RSM01", 1],
  ["fn_complete_call_facts", "NRT01", 2],
  ["fn_save_offer_calculation", "NRT01", 1],
  ["save_unverified_lead_phone", "NRT01", 1],
];
const TRANSIENT = [
  "claim_verified_esign_webhook_receipt",
  "register_dropbox_website_esign_template",
  "create_promote_leads_job",
  "retry_promote_leads_job",
  "process_promote_leads_item",
];
const rollbackSql = readFileSync(
  new URL("../rollbacks/20261021130000_deterministic_conflicts_non_retryable_sqlstate.sql", import.meta.url),
  "utf8",
);

async function def(name: string): Promise<string> {
  const { rows } = await db.query(
    `select pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = $1 and p.prokind = 'f'`,
    [name],
  );
  expect(rows).toHaveLength(1);
  return rows[0].def as string;
}
const count = (text: string, needle: string) => text.split(needle).length - 1;

beforeAll(async () => {
  await db.connect();
});
afterAll(async () => {
  await db.end();
});
beforeEach(async () => {
  await db.query("begin");
});
afterEach(async () => {
  await db.query("rollback");
});

describe("deterministic conflict SQLSTATEs (20261021130000)", () => {
  it.each(CHANGED)("%s raises %s exactly %i times and no 40001", async (name, code, expected) => {
    const text = await def(name);
    expect(count(text, `'${code}'`)).toBe(expected);
    expect(text.match(new RegExp(`errcode\\s*=\\s*'${code}'`, "g"))?.length).toBe(expected);
    expect(text).not.toContain("'40001'");
  });

  it("leaves the genuinely transient races on 40001", async () => {
    for (const name of TRANSIENT) expect(await def(name)).toMatch(/errcode\s*=\s*'40001'/);
  });

  it("keeps message texts unchanged", async () => {
    expect(await def("fn_undo_jev_action")).toContain("raise exception 'STATE_CHANGED' using errcode = 'JDC01';");
    expect(await def("fn_set_template_auto_send_approval")).toContain("raise exception 'CONTENT_CHANGED' using errcode = 'JDC01';");
    expect(await def("fn_record_dialpad_recording_chunk")).toContain(
      "raise exception 'CHUNK_CONFLICT' using errcode = 'DPR01', detail = 'chunk_conflict';",
    );
    expect(await def("save_unverified_lead_phone")).toMatch(/errcode = 'NRT01',\s*message = 'PHONE_SLOT_CHANGED: retry lead intake';/);
  });

  it("the rollback restores 40001 on every changed raise", async () => {
    await db.query(rollbackSql.replace(/^[\s\S]*?\bbegin;\s*/i, "").replace(/\s*commit;\s*$/i, ""));
    for (const [name, code, expected] of CHANGED) {
      const text = await def(name);
      expect(count(text, "'40001'"), name).toBe(expected);
      expect(text, name).not.toContain(`'${code}'`);
    }
  });
});
