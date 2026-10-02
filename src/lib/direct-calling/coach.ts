import "server-only";

import { createHmac } from "node:crypto";
import { assertValidScriptBundle, computeScriptDigest, type ScriptBundle } from "@biginkc/coach";
import { createAdminClient } from "@/lib/supabase/admin";
import type { DirectCallFullRow } from "./store";
import type { TelnyxDirectSettings } from "./config";
import { deterministicCommandId } from "./transitions";

type Binding = { client_call_id: string; operator_user_id: string; property_id: string | null; script_slug: string; script_revision: number; script_digest: string };
type Result = { data: unknown; error: { message: string } | null };
type Query = { select(columns: string): Query; eq(column: string, value: string): Query; maybeSingle(): PromiseLike<Result> };
type Admin = { from(table: string): Query & { upsert(values: Binding, options: { onConflict: string; ignoreDuplicates: boolean }): PromiseLike<{ error: { message: string } | null }> } };

export function directCoachStreamUrl(input: { baseUrl: string; secret: string; callId: string; sellerLegId: string; expiresAtMs: number }): string {
  const url = new URL(input.baseUrl);
  if (url.protocol !== "wss:" || url.username || url.password || input.secret.length < 32) throw new Error("direct_coach_configuration_invalid");
  url.pathname = "/media";
  url.search = "";
  url.hash = "";
  const payload = Buffer.from(JSON.stringify({ callId: input.callId, sellerLegId: input.sellerLegId, expiresAtMs: input.expiresAtMs })).toString("base64url");
  const signature = createHmac("sha256", input.secret).update(payload).digest("base64url");
  url.searchParams.set("token", `${payload}.${signature}`);
  return url.toString();
}

/** Insert-once binding: a webhook retry must never replace a call's script or owner. */
export async function bindDirectCoachCall(row: DirectCallFullRow, slug: string, adminValue: unknown = createAdminClient()): Promise<void> {
  const admin = adminValue as Admin;
  const existing = await admin.from("coach_call_index").select("*").eq("client_call_id", row.id).maybeSingle();
  if (existing.error) throw new Error("direct_coach_binding_read_failed");
  if (!existing.data) {
    const result = await admin.from("coach_script_defaults").select("digest, coach_script_revisions!coach_script_defaults_digest_slug_fkey(slug, revision, bundle, import_status)").eq("slug", slug).maybeSingle();
    if (result.error || !result.data || typeof result.data !== "object") throw new Error("direct_coach_script_unavailable");
    const value = result.data as { digest?: unknown; coach_script_revisions?: unknown };
    const revision = Array.isArray(value.coach_script_revisions) ? value.coach_script_revisions[0] : value.coach_script_revisions;
    if (!revision || typeof revision !== "object") throw new Error("direct_coach_script_unavailable");
    const script = revision as { slug?: unknown; revision?: unknown; bundle?: unknown; import_status?: unknown };
    if (script.slug !== slug || !Number.isInteger(script.revision) || script.import_status !== "reviewed" || typeof value.digest !== "string") throw new Error("direct_coach_script_unreviewed");
    assertValidScriptBundle(script.bundle);
    if (await computeScriptDigest(script.bundle as ScriptBundle) !== value.digest) throw new Error("direct_coach_script_digest_mismatch");
    const inserted = await admin.from("coach_call_index").upsert({ client_call_id: row.id, operator_user_id: row.operator_user_id, property_id: row.property_id, script_slug: slug, script_revision: script.revision as number, script_digest: value.digest }, { onConflict: "client_call_id", ignoreDuplicates: true });
    if (inserted.error) throw new Error("direct_coach_binding_write_failed");
  }
  const bound = await admin.from("coach_call_index").select("*").eq("client_call_id", row.id).maybeSingle();
  const value = bound.data as Partial<Binding> | null;
  if (bound.error || !value || value.operator_user_id !== row.operator_user_id || value.property_id !== row.property_id || !value.script_slug || !value.script_revision || !value.script_digest) throw new Error("direct_coach_binding_invalid");
}

/** Invoked only after a signed seller answer/bridge has updated the owned call row. */
export function createDirectCoachStarter(options: {
  settings: TelnyxDirectSettings;
  env?: Record<string, string | undefined>;
  bind?: typeof bindDirectCoachCall;
  fetchImpl?: typeof fetch;
  now?: () => number;
}) {
  const env = options.env ?? process.env;
  return async (row: DirectCallFullRow): Promise<void> => {
    if (env.DIRECT_COACH_ENABLED !== "true") return;
    if (row.status !== "connected" || !row.seller_leg_id || !row.connected_at) return;
    const now = options.now?.() ?? Date.now();
    const deadline = Date.parse(row.connected_at) + Math.min(row.time_limit_secs, 180) * 1000;
    if (!Number.isFinite(deadline) || deadline <= now) return;
    const baseUrl = env.DIRECT_COACH_STREAM_URL;
    const secret = env.DIRECT_COACH_STREAM_SECRET;
    const slug = env.DIRECT_COACH_SCRIPT_SLUG;
    if (!baseUrl || !secret || !slug) throw new Error("direct_coach_configuration_missing");
    await (options.bind ?? bindDirectCoachCall)(row, slug);
    const streamUrl = directCoachStreamUrl({ baseUrl, secret, callId: row.id, sellerLegId: row.seller_leg_id, expiresAtMs: deadline });
    const response = await (options.fetchImpl ?? fetch)(`https://api.telnyx.com/v2/calls/${encodeURIComponent(row.seller_leg_id)}/actions/streaming_start`, {
      method: "POST",
      headers: { Authorization: `Bearer ${options.settings.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ stream_url: streamUrl, stream_track: "both_tracks", command_id: deterministicCommandId(`${row.id}:direct-coach-stream`) }),
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    // Never include provider bodies or the capability URL in errors/logs.
    if (!response.ok) throw new Error(`direct_coach_stream_http_${response.status}`);
  };
}
