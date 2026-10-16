import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "pg";

/** Inside a caller-owned rollback transaction on a verified disposable database only.
 * Replay the complete admitted dependency chain on both legacy and fully migrated fixtures.
 */
export async function applyNormaFollowups(db: Client) {
  await db.query(`
    drop function if exists public.fn_norma_finish_recording_lookup(uuid,boolean);
    drop function if exists public.fn_norma_checkpoint_recording(uuid,smallint,text,smallint,uuid,text);
    drop function if exists public.fn_norma_start_recording_lookup(uuid);
    drop function if exists public.fn_norma_claim_recordings();
    drop function if exists public.fn_norma_seed_recordings();
    drop table if exists public.norma_attempt_recordings;
    drop table if exists public.norma_recording_lookup_control;
    drop function if exists public.fn_norma_finish_inbound_lookup(uuid,boolean);
    drop function if exists public.fn_norma_checkpoint_inbound_lookup(uuid,smallint,uuid,text);
    drop function if exists public.fn_norma_start_inbound_lookup(uuid,uuid);
    drop function if exists public.fn_norma_pause_inbound_lookups();
    drop table if exists public.norma_inbound_lookup_control;
    drop function if exists public.fn_norma_claim_inbound_recordings();
    drop function if exists public.fn_norma_associate_inbound_call(uuid,uuid,timestamptz);
    drop function if exists norma_private.associate_inbound_call(uuid,uuid,timestamptz);
    drop function if exists public.fn_norma_ingest_inbound_call(text,text,text,boolean,text);
    drop table if exists public.norma_inbound_reviews;
    drop table if exists public.norma_inbound_calls;
    drop table if exists public.norma_inbound_destinations;
  `);
  const directory = path.join(process.cwd(), "supabase/migrations");
  for (const suffix of ["_norma_retry_next_step_union_reviewed.sql", "_norma_inbound_call_records.sql", "_norma_outbound_recording_state.sql"]) {
    const files = readdirSync(directory).filter((file) => file.endsWith(suffix));
    if (files.length !== 1) throw new Error(`Expected one canonical migration for ${suffix}`);
    await db.query(readFileSync(path.join(directory, files[0]), "utf8").replace(/^\s*(begin|commit);\s*$/gim, ""));
  }
}
