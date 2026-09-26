import { createHmac } from "node:crypto";

import {
  assertValidScriptBundle,
  computeScriptDigest,
  type ScriptBundle,
  type ScriptRef,
} from "@biginkc/coach";

import { reportInfo } from "@/lib/errors/report";
import { createAdminClient } from "@/lib/supabase/admin";

const CLOSER_SCRIPTS_PATH = "/api/internal/sandra/coach-scripts";
const FETCH_TIMEOUT_MS = 10_000;

export type CachedCoachScript = ScriptRef & {
  schemaVersion: number;
  bundle: ScriptBundle;
  importStatus: "reviewed" | "unreviewed";
};

type RemoteScript = {
  slug: unknown;
  revision: unknown;
  digest: unknown;
  schema_version: unknown;
  import_status: unknown;
  bundle: unknown;
};

type CacheAdmin = {
  from(table: "coach_script_revisions"): {
    upsert(values: Record<string, unknown>, options: { onConflict: string; ignoreDuplicates: boolean }): Promise<{ error: { message: string } | null }>;
  };
  from(table: "coach_script_defaults"): {
    upsert(values: Record<string, unknown>, options: { onConflict: string }): Promise<{ error: { message: string } | null }>;
    select(columns: string): { eq(column: string, value: string): { maybeSingle(): Promise<{ data: unknown; error: { message: string } | null }> } };
  };
};

function isImportStatus(value: unknown): value is "reviewed" | "unreviewed" {
  return value === "reviewed" || value === "unreviewed";
}

async function validatedRemoteScript(value: RemoteScript): Promise<CachedCoachScript> {
  if (
    typeof value.slug !== "string" || !value.slug ||
    !Number.isInteger(value.revision) || (value.revision as number) <= 0 ||
    typeof value.digest !== "string" || !/^[0-9a-f]{64}$/.test(value.digest) ||
    !Number.isInteger(value.schema_version) || (value.schema_version as number) <= 0 ||
    !isImportStatus(value.import_status)
  ) throw new Error("Closer Lab returned an invalid coach script reference");
  const revision = value.revision as number;
  const schemaVersion = value.schema_version as number;

  assertValidScriptBundle(value.bundle);
  const bundle = value.bundle as ScriptBundle;
  if (bundle.schema_version !== value.schema_version) {
    throw new Error(`Closer Lab returned mismatched schema version for ${value.slug}@${revision}`);
  }
  const digest = await computeScriptDigest(bundle);
  if (digest !== value.digest) {
    throw new Error(`Closer Lab digest mismatch for ${value.slug}@${revision}`);
  }
  return { slug: value.slug, revision, digest, schemaVersion, importStatus: value.import_status, bundle };
}

export async function syncCoachScriptCache(deps: {
  fetch: typeof fetch;
  admin: CacheAdmin;
  baseUrl?: string;
  token?: string;
  now?: () => number;
}): Promise<{ ok: true; skipped?: "missing_configuration"; synced?: number }> {
  const baseUrl = deps.baseUrl ?? process.env.CLOSER_LAB_API_BASE_URL;
  const token = deps.token ?? process.env.SANDRA_SERVICE_TOKEN;
  if (!baseUrl || !token) {
    reportInfo("Coach script sync skipped: CLOSER_LAB_API_BASE_URL or SANDRA_SERVICE_TOKEN is not configured", { tags: { surface: "coach_script_sync", outcome: "missing_configuration" } });
    return { ok: true, skipped: "missing_configuration" };
  }

  const url = new URL(CLOSER_SCRIPTS_PATH, baseUrl);
  const timestamp = String(Math.floor((deps.now?.() ?? Date.now()) / 1_000));
  const signature = `sha256=${createHmac("sha256", token).update(`${timestamp}.${url.pathname}`).digest("hex")}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await deps.fetch(url, { headers: { authorization: `Bearer ${token}`, "x-sandra-timestamp": timestamp, "x-sandra-signature": signature }, cache: "no-store", signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new Error(`Closer Lab coach script sync failed with HTTP ${response.status}`);
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { scripts?: unknown }).scripts)) {
    throw new Error("Closer Lab returned an invalid coach script catalogue");
  }
  const scripts = await Promise.all((payload as { scripts: RemoteScript[] }).scripts.map(validatedRemoteScript));
  for (const script of scripts) {
    const revision = await deps.admin.from("coach_script_revisions").upsert({
      digest: script.digest, slug: script.slug, revision: script.revision,
      schema_version: script.schemaVersion, bundle: script.bundle, import_status: script.importStatus,
    }, { onConflict: "digest", ignoreDuplicates: true });
    if (revision.error) throw new Error(`Could not cache ${script.slug}@${script.revision}: ${revision.error.message}`);
    const defaultResult = await deps.admin.from("coach_script_defaults").upsert(
      { slug: script.slug, digest: script.digest, updated_at: new Date().toISOString() },
      { onConflict: "slug" },
    );
    if (defaultResult.error) throw new Error(`Could not set cached default for ${script.slug}: ${defaultResult.error.message}`);
  }
  return { ok: true, synced: scripts.length };
}

/** Resolves exactly the cached default. It intentionally has no fallback. */
export async function loadCachedCoachDefault(
  slug: string,
  admin = createAdminClient() as unknown as CacheAdmin,
): Promise<Pick<ScriptRef, "slug" | "revision" | "digest"> | null> {
  const result = await admin.from("coach_script_defaults").select(
    "digest, coach_script_revisions!coach_script_defaults_digest_slug_fkey(slug, revision)",
  ).eq("slug", slug).maybeSingle();
  if (result.error || !result.data || typeof result.data !== "object") return null;
  const row = result.data as { digest?: unknown; coach_script_revisions?: unknown };
  const revision = Array.isArray(row.coach_script_revisions) ? row.coach_script_revisions[0] : row.coach_script_revisions;
  if (!revision || typeof revision !== "object") return null;
  const ref = revision as { slug?: unknown; revision?: unknown };
  return typeof row.digest === "string" && ref.slug === slug && Number.isInteger(ref.revision)
    ? { slug, revision: ref.revision as number, digest: row.digest }
    : null;
}
