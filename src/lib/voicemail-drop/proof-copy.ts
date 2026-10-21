import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

/**
 * Durable proof of delivery (voicemail drop PR 7). Drop Cowboy keeps the
 * recording behind a drop's proof_of_delivery_url for 7 days; Sandra keeps
 * its own copy in the private `voicemail-drop-proofs` bucket at
 * `<org_id>/<drop row id>.<ext>`.
 *
 * Idempotent: a drop that already holds a stored copy is never fetched again,
 * and the object path is fixed per drop, so a concurrent or replayed copy
 * overwrites the same bytes. A failed download keeps proof_url, marks the
 * copy pending with a backoff, and the sweep retries it until the provider
 * link expires.
 */

export const PROOF_BUCKET = "voicemail-drop-proofs";
/** Provider link lifetime. */
export const PROOF_URL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const PROOF_FETCH_TIMEOUT_MS = 15_000;
/** Matches the bucket's file_size_limit (25 MB). */
export const PROOF_MAX_BYTES = 25 * 1024 * 1024;
export const PROOF_MAX_ATTEMPTS = 12;
/** Signed URL lifetime for the timeline link. */
export const PROOF_SIGNED_URL_TTL_SECONDS = 60;

/** Content type → file extension. Must stay inside the bucket's allowed_mime_types. */
export const PROOF_CONTENT_TYPES: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
  "audio/webm": "webm",
};

export type ProofDrop = {
  id: string;
  org_id: string;
  proof_url: string | null;
  proof_url_at: string | null;
  completed_at: string | null;
  proof_storage_path: string | null;
  proof_copy_status: string | null;
  proof_copy_attempts: number;
};

export type StoredProofFacts = {
  proof_storage_path: string;
  proof_content_type: string;
  proof_size_bytes: number;
  proof_fetched_at: string;
};

export interface ProofCopyStore {
  getDrop(id: string): Promise<ProofDrop | null>;
  /** Stamp when a receipt saved proof_url (starts its 7 days; queues the sweep). */
  markReceived(id: string, atIso: string): Promise<void>;
  /** Stored copy facts; only writes when the drop has no stored copy yet. */
  markStored(id: string, facts: StoredProofFacts): Promise<void>;
  markPending(id: string, attempts: number, nextAt: string, error: string): Promise<void>;
  markFailed(id: string, attempts: number, error: string): Promise<void>;
  upload(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** Drops whose copy is pending and due. */
  listDue(nowIso: string, limit: number): Promise<string[]>;
}

export type ProofCopyResult =
  | "stored"
  | "already_stored"
  | "no_proof_url"
  | "pending"
  | "failed"
  | "not_found";

export class ProofDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProofDownloadError";
  }
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/** When the provider link stops working: proof_url_at (or completed_at) + 7 days. */
export function proofUrlExpiresAt(drop: Pick<ProofDrop, "proof_url_at" | "completed_at">): number | null {
  const at = drop.proof_url_at ?? drop.completed_at;
  if (!at) return null;
  const ms = new Date(at).getTime();
  return Number.isFinite(ms) ? ms + PROOF_URL_TTL_MS : null;
}

/** Backoff after the n-th failure: 5m, 10m, 20m … capped at 6h. */
export function proofRetryDelayMs(attempts: number): number {
  return Math.min(5 * 60_000 * 2 ** Math.max(0, attempts - 1), 6 * 60 * 60_000);
}

function baseContentType(header: string | null): string {
  return (header ?? "").split(";")[0].trim().toLowerCase();
}

/** Download the recording: https only, timeout, size cap, audio content type. */
export async function downloadProof(
  url: string,
  fetcher: Fetcher = fetch,
  timeoutMs: number = PROOF_FETCH_TIMEOUT_MS,
  maxBytes: number = PROOF_MAX_BYTES,
): Promise<{ bytes: Uint8Array; contentType: string; ext: string }> {
  if (!url.startsWith("https://")) throw new ProofDownloadError("proof url is not https");
  let response: Response;
  try {
    // The proof URL redirects to a short-lived audio URL; follow it now.
    response = await fetcher(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
  } catch (error) {
    throw new ProofDownloadError(`proof fetch failed: ${error instanceof Error ? error.name : String(error)}`);
  }
  if (!response.ok) throw new ProofDownloadError(`proof fetch status ${response.status}`);
  const contentType = baseContentType(response.headers.get("content-type"));
  const ext = PROOF_CONTENT_TYPES[contentType];
  if (!ext) throw new ProofDownloadError(`proof content type not audio: ${contentType || "none"}`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new ProofDownloadError("proof too large");
  if (!response.body) throw new ProofDownloadError("proof body empty");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (error) {
      throw new ProofDownloadError(`proof read failed: ${error instanceof Error ? error.name : String(error)}`);
    }
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ProofDownloadError("proof too large");
    }
    chunks.push(chunk.value);
  }
  if (total === 0) throw new ProofDownloadError("proof body empty");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return { bytes, contentType, ext };
}

export function proofStoragePath(orgId: string, dropRowId: string, ext: string): string {
  return `${orgId}/${dropRowId}.${ext}`;
}

/**
 * Copy one drop's proof into Storage. A download or upload problem is
 * recorded as pending/failed, never thrown; only a DB read/write error throws
 * (the sweep also picks up receipts with no copy status yet).
 */
export async function copyDropProof(
  store: ProofCopyStore,
  dropRowId: string,
  opts: { fetcher?: Fetcher; now?: Date; receivedAt?: Date } = {},
): Promise<ProofCopyResult> {
  const now = opts.now ?? new Date();
  if (opts.receivedAt) await store.markReceived(dropRowId, opts.receivedAt.toISOString());
  const drop = await store.getDrop(dropRowId);
  if (!drop) return "not_found";
  if (drop.proof_storage_path) return "already_stored";
  if (!drop.proof_url) return "no_proof_url";

  let downloaded: Awaited<ReturnType<typeof downloadProof>>;
  let path: string;
  try {
    downloaded = await downloadProof(drop.proof_url, opts.fetcher);
    path = proofStoragePath(drop.org_id, drop.id, downloaded.ext);
    await store.upload(path, downloaded.bytes, downloaded.contentType);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const attempts = drop.proof_copy_attempts + 1;
    const expiresAt = proofUrlExpiresAt(drop);
    const nextAt = now.getTime() + proofRetryDelayMs(attempts);
    if (attempts >= PROOF_MAX_ATTEMPTS || (expiresAt !== null && nextAt >= expiresAt)) {
      await store.markFailed(drop.id, attempts, message);
      return "failed";
    }
    await store.markPending(drop.id, attempts, new Date(nextAt).toISOString(), message);
    return "pending";
  }

  await store.markStored(drop.id, {
    proof_storage_path: path,
    proof_content_type: downloaded.contentType,
    proof_size_bytes: downloaded.bytes.byteLength,
    proof_fetched_at: now.toISOString(),
  });
  return "stored";
}

/** Retry due pending copies (cron). */
export async function sweepPendingProofCopies(
  store: ProofCopyStore,
  opts: { fetcher?: Fetcher; now?: Date; limit?: number } = {},
): Promise<Record<ProofCopyResult, number>> {
  const now = opts.now ?? new Date();
  const counts: Record<ProofCopyResult, number> = {
    stored: 0, already_stored: 0, no_proof_url: 0, pending: 0, failed: 0, not_found: 0,
  };
  const ids = await store.listDue(now.toISOString(), opts.limit ?? 10);
  for (const id of ids) counts[await copyDropProof(store, id, { fetcher: opts.fetcher, now })] += 1;
  return counts;
}

const PROOF_DROP_COLUMNS =
  "id, org_id, proof_url, proof_url_at, completed_at, proof_storage_path, proof_copy_status, proof_copy_attempts";

/** Service-role store. */
export function supabaseProofCopyStore(client: SupabaseClient<Database>): ProofCopyStore {
  return {
    async getDrop(id) {
      const { data, error } = await client.from("voicemail_drops").select(PROOF_DROP_COLUMNS).eq("id", id).maybeSingle();
      if (error) throw new Error(`proof getDrop: ${error.message}`);
      return (data as ProofDrop | null) ?? null;
    },
    async markReceived(id, atIso) {
      const { error } = await client.from("voicemail_drops").update({ proof_url_at: atIso }).eq("id", id);
      if (error) throw new Error(`proof markReceived: ${error.message}`);
    },
    async markStored(id, facts) {
      const { error } = await client
        .from("voicemail_drops")
        .update({ ...facts, proof_copy_status: "stored", proof_copy_next_at: null, proof_copy_error: null })
        .eq("id", id)
        .is("proof_storage_path", null);
      if (error) throw new Error(`proof markStored: ${error.message}`);
    },
    async markPending(id, attempts, nextAt, message) {
      const { error } = await client
        .from("voicemail_drops")
        .update({ proof_copy_status: "pending", proof_copy_attempts: attempts, proof_copy_next_at: nextAt, proof_copy_error: message })
        .eq("id", id)
        .is("proof_storage_path", null);
      if (error) throw new Error(`proof markPending: ${error.message}`);
    },
    async markFailed(id, attempts, message) {
      const { error } = await client
        .from("voicemail_drops")
        .update({ proof_copy_status: "failed", proof_copy_attempts: attempts, proof_copy_next_at: null, proof_copy_error: message })
        .eq("id", id)
        .is("proof_storage_path", null);
      if (error) throw new Error(`proof markFailed: ${error.message}`);
    },
    async upload(path, bytes, contentType) {
      const { error } = await client.storage.from(PROOF_BUCKET).upload(path, bytes, { contentType, upsert: true });
      if (error) throw new Error(`proof upload: ${error.message}`);
    },
    async listDue(nowIso, limit) {
      const { data, error } = await client
        .from("voicemail_drops")
        .select("id")
        .or(`and(proof_copy_status.eq.pending,proof_copy_next_at.lte.${nowIso}),and(proof_copy_status.is.null,proof_url_at.not.is.null)`)
        .not("proof_url", "is", null)
        .order("proof_copy_next_at", { ascending: true, nullsFirst: true })
        .limit(limit);
      if (error) throw new Error(`proof listDue: ${error.message}`);
      return (data ?? []).map((r) => r.id);
    },
  };
}
