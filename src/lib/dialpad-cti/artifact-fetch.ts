import type { SupabaseClient } from '@supabase/supabase-js';

import { reportError } from '@/lib/errors/report';
import type { Database, Json } from '@/lib/supabase/types';

import { DIALPAD_API_ORIGIN, resolveDialpadDirectoryKey, type DialpadDirectoryEnv, type DialpadDirectoryFetch } from './directory';

/**
 * Hangup-triggered transcript and AI Recap fetch (decision D5). The database owns the queue
 * (`dialpad_call_artifact_fetches`: one row per call activity and artifact, readiness per artifact,
 * retries at 1, 5, 15 and 60 minutes after hangup); this module only claims due rows, calls Dialpad and
 * records the outcome. Nothing here runs unless the per-org `artifact_fetch` flag is on: the claim function
 * only returns rows of orgs with the flag set, so a missing flag row, column or table reads as OFF.
 *
 * Status mapping (a 404 or empty body is "not ready yet", never a failure):
 *   200 with content -> available   404 / empty -> not_ready   429 -> not_ready (backoff is the schedule)
 *   401 / 403 -> denied (terminal, wrong scope or key)   5xx, timeout, network -> error (counts as an attempt)
 * Only status codes are ever stored or reported, never a response body, a key or a transcript.
 */

export type ArtifactKind = 'transcript' | 'recap' | 'recording_link';

export type ArtifactFetchResult =
  | { outcome: 'available'; text?: string; language?: string; summary?: string }
  | { outcome: 'not_ready'; error?: string }
  | { outcome: 'denied'; error: string }
  | { outcome: 'error'; error: string };

export interface ArtifactFetchRow {
  id: string;
  orgId: string;
  artifact: ArtifactKind;
  providerCallId: string;
  callActivityId: string;
  attempts: number;
  endedAt: string;
}

export interface DialpadArtifactDb {
  claim(limit: number, artifacts: readonly ('transcript' | 'recap')[]): Promise<ArtifactFetchRow[]>;
  record(id: string, result: ArtifactFetchResult): Promise<void>;
  /** The org's Dialpad API key, or null when none is configured. Never logged. */
  loadKey(orgId: string): Promise<string | null>;
  /** Resolves due recording_link rows (no provider call); returns the flagged rows for reporting. */
  resolveRecordingLinks(): Promise<{ available: number; flagged: { id: string; callActivityId: string }[] }>;
}

const DIGITS = /^[0-9]{1,20}$/;
const REQUEST_TIMEOUT_MS = 8000;
const MAX_RESPONSE_CHARS = 2_000_000;
const MAX_STORED_TEXT = 500_000;

/** Phase 0 names the AI Recap endpoint; until it does the recap rows are left pending (never consumed). */
export const DIALPAD_RECAP_PATH: string | null = null;
export const DIALPAD_TRANSCRIPT_PATH = '/api/v2/transcripts/{call_id}';

const INT64_FIELDS = /"(call_id|id|user_id|master_call_id)"(\s*:\s*)(-?\d{1,20})(?=\s*[,}\]])/g;

function parseJson(raw: string): Record<string, unknown> | null {
  if (raw.length === 0 || raw.length > MAX_RESPONSE_CHARS) return null;
  try {
    const parsed: unknown = JSON.parse(raw.replace(INT64_FIELDS, '"$1"$2"$3"'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Joins the transcript lines as "Speaker: text". Null when there is nothing usable yet. */
export function parseDialpadTranscript(raw: string): { text: string; language?: string } | null {
  const body = parseJson(raw);
  const lines = body && Array.isArray(body.lines) ? body.lines : null;
  if (!lines) return null;
  const parts: string[] = [];
  for (const line of lines) {
    if (!line || typeof line !== 'object') continue;
    const row = line as Record<string, unknown>;
    const content = typeof row.content === 'string' ? row.content.trim() : '';
    if (!content) continue;
    const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : 'Speaker';
    parts.push(`${name}: ${content}`);
  }
  if (parts.length === 0) return null;
  const text = parts.join('\n').slice(0, MAX_STORED_TEXT);
  const language = typeof body?.language === 'string' && /^[A-Za-z-]{2,12}$/.test(body.language) ? body.language : undefined;
  return language ? { text, language } : { text };
}

/** Recap parsing waits on the Phase 0 capture; this accepts only a plain top-level `summary` string. */
export function parseDialpadRecap(raw: string): { summary: string } | null {
  const body = parseJson(raw);
  const summary = body && typeof body.summary === 'string' ? body.summary.trim() : '';
  return summary ? { summary: summary.slice(0, MAX_STORED_TEXT) } : null;
}

async function getJson(path: string, callId: string, apiKey: string, fetchImpl?: DialpadDirectoryFetch):
  Promise<{ ok: true; text: string } | { ok: false; result: ArtifactFetchResult }> {
  if (!DIGITS.test(callId)) return { ok: false, result: { outcome: 'error', error: 'invalid_call_id' } };
  const doFetch: DialpadDirectoryFetch = fetchImpl ?? ((url, init) => fetch(url, init));
  let response: { status: number; text(): Promise<string> };
  try {
    response = await doFetch(`${DIALPAD_API_ORIGIN}${path.replace('{call_id}', callId)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, result: { outcome: 'error', error: 'network' } };
  }
  if (response.status === 404) return { ok: false, result: { outcome: 'not_ready', error: '404' } };
  if (response.status === 429) return { ok: false, result: { outcome: 'not_ready', error: '429' } };
  if (response.status === 401 || response.status === 403) return { ok: false, result: { outcome: 'denied', error: String(response.status) } };
  if (response.status !== 200) return { ok: false, result: { outcome: 'error', error: String(response.status) } };
  try {
    return { ok: true, text: await response.text() };
  } catch {
    return { ok: false, result: { outcome: 'error', error: 'network' } };
  }
}

export async function fetchDialpadTranscript(input: { callId: string; apiKey: string; fetchImpl?: DialpadDirectoryFetch }): Promise<ArtifactFetchResult> {
  const got = await getJson(DIALPAD_TRANSCRIPT_PATH, input.callId, input.apiKey, input.fetchImpl);
  if (!got.ok) return got.result;
  const parsed = parseDialpadTranscript(got.text);
  return parsed ? { outcome: 'available', ...parsed } : { outcome: 'not_ready', error: 'empty' };
}

export async function fetchDialpadRecap(input: { callId: string; apiKey: string; fetchImpl?: DialpadDirectoryFetch }): Promise<ArtifactFetchResult> {
  if (!DIALPAD_RECAP_PATH) return { outcome: 'error', error: 'recap_path_unset' };
  const got = await getJson(DIALPAD_RECAP_PATH, input.callId, input.apiKey, input.fetchImpl);
  if (!got.ok) return got.result;
  const parsed = parseDialpadRecap(got.text);
  return parsed ? { outcome: 'available', ...parsed } : { outcome: 'not_ready', error: 'empty' };
}

export interface ArtifactSweepSummary {
  claimed: number;
  available: number;
  notReady: number;
  denied: number;
  errors: number;
  linksAvailable: number;
  linksFlagged: number;
}

export async function sweepDialpadArtifacts(
  db: DialpadArtifactDb,
  deps: { fetchImpl?: DialpadDirectoryFetch; limit?: number; recapPath?: string | null } = {},
): Promise<ArtifactSweepSummary> {
  const summary: ArtifactSweepSummary = { claimed: 0, available: 0, notReady: 0, denied: 0, errors: 0, linksAvailable: 0, linksFlagged: 0 };
  const recapEnabled = deps.recapPath !== undefined ? deps.recapPath !== null : DIALPAD_RECAP_PATH !== null;
  const rows = await db.claim(deps.limit ?? 10, recapEnabled ? ['transcript', 'recap'] : ['transcript']);
  summary.claimed = rows.length;
  const keys = new Map<string, string | null>();
  for (const row of rows) {
    let result: ArtifactFetchResult;
    try {
      if (!keys.has(row.orgId)) keys.set(row.orgId, await db.loadKey(row.orgId));
      const apiKey = keys.get(row.orgId) ?? null;
      if (!apiKey) result = { outcome: 'denied', error: 'no_key' };
      else if (row.artifact === 'transcript') result = await fetchDialpadTranscript({ callId: row.providerCallId, apiKey, fetchImpl: deps.fetchImpl });
      else result = await fetchDialpadRecap({ callId: row.providerCallId, apiKey, fetchImpl: deps.fetchImpl });
    } catch {
      result = { outcome: 'error', error: 'unexpected' };
    }
    try {
      await db.record(row.id, result);
    } catch (error) {
      reportError(error, { tags: { surface: 'dialpad_artifact_record' } });
      summary.errors += 1;
      continue;
    }
    if (result.outcome === 'available') summary.available += 1;
    else if (result.outcome === 'not_ready') summary.notReady += 1;
    else if (result.outcome === 'denied') summary.denied += 1;
    else summary.errors += 1;
  }
  const links = await db.resolveRecordingLinks();
  summary.linksAvailable = links.available;
  summary.linksFlagged = links.flagged.length;
  for (const flagged of links.flagged) {
    reportError(new Error('Dialpad call finished without a recording link'), {
      level: 'warning',
      tags: { surface: 'dialpad_artifact_missing_link' },
      extra: { fetchId: flagged.id, callActivityId: flagged.callActivityId },
    });
  }
  return summary;
}

type Row = { id?: unknown; orgId?: unknown; artifact?: unknown; providerCallId?: unknown; callActivityId?: unknown; attempts?: unknown; endedAt?: unknown };

function parseRows(data: Json | null): ArtifactFetchRow[] {
  if (!Array.isArray(data)) return [];
  const rows: ArtifactFetchRow[] = [];
  for (const item of data as Row[]) {
    if (
      item && typeof item.id === 'string' && typeof item.orgId === 'string' && typeof item.providerCallId === 'string'
      && typeof item.callActivityId === 'string' && typeof item.endedAt === 'string' && typeof item.attempts === 'number'
      && (item.artifact === 'transcript' || item.artifact === 'recap')
    ) {
      rows.push({ id: item.id, orgId: item.orgId, artifact: item.artifact, providerCallId: item.providerCallId,
        callActivityId: item.callActivityId, attempts: item.attempts, endedAt: item.endedAt });
    }
  }
  return rows;
}

export function createSupabaseDialpadArtifactDb(client: SupabaseClient<Database>, env: DialpadDirectoryEnv = process.env): DialpadArtifactDb {
  return {
    async claim(limit, artifacts) {
      const { data, error } = await client.rpc('fn_claim_dialpad_artifact_fetches', {
        p_limit: limit, p_lease_seconds: 120, p_artifacts: [...artifacts],
      });
      if (error) throw new Error(`artifact claim failed (${error.code ?? 'unknown'})`);
      return parseRows(data);
    },
    async record(id, result) {
      const { error } = await client.rpc('fn_record_dialpad_artifact_result', {
        p_id: id,
        p_outcome: result.outcome,
        p_error: 'error' in result ? result.error : undefined,
        p_text: result.outcome === 'available' ? result.text : undefined,
        p_language: result.outcome === 'available' ? result.language : undefined,
        p_summary: result.outcome === 'available' ? result.summary : undefined,
      });
      if (error) throw new Error(`artifact record failed (${error.code ?? 'unknown'})`);
    },
    async loadKey(orgId) {
      const { data, error } = await client.from('dialpad_org_connections').select('directory_api_key_ref').eq('org_id', orgId).maybeSingle();
      if (error || !data) return null;
      return resolveDialpadDirectoryKey(data.directory_api_key_ref, env);
    },
    async resolveRecordingLinks() {
      const { data, error } = await client.rpc('fn_resolve_dialpad_recording_links', { p_limit: 50 });
      if (error) throw new Error(`recording link resolve failed (${error.code ?? 'unknown'})`);
      const body = (data ?? {}) as { available?: unknown; flagged?: unknown };
      const flagged = Array.isArray(body.flagged)
        ? (body.flagged as { id?: unknown; callActivityId?: unknown }[])
            .filter((f) => typeof f.id === 'string' && typeof f.callActivityId === 'string')
            .map((f) => ({ id: f.id as string, callActivityId: f.callActivityId as string }))
        : [];
      return { available: typeof body.available === 'number' ? body.available : 0, flagged };
    },
  };
}
