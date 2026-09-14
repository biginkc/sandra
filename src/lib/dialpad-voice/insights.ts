import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DialpadInsightsDatabase } from "./insights-database.generated";

type TranscriptLine = { content: string; name: string; time: string; type: string; user_id: string };
/** All failures retryable by the bounded inbox retry policy; no customer data in errors. */
export class DialpadInsightRetry extends Error {
  constructor() { super("Dialpad insight unavailable"); }
}
export function parseDialpadTranscript(value: unknown, callId: string): { text: string; lines: TranscriptLine[] } {
  if (!value || typeof value !== "object") throw new DialpadInsightRetry();
  const data = value as Record<string, unknown>;
  if (String(data.call_id) !== callId || !Array.isArray(data.lines) || data.lines.length > 20000) throw new DialpadInsightRetry();
  const lines: TranscriptLine[] = data.lines.map((item: unknown) => {
    if (!item || typeof item !== "object") throw new DialpadInsightRetry();
    const row = item as Record<string, unknown>;
    for (const key of ["content", "name", "time", "type", "user_id"]) {
      if (typeof row[key] !== "string" || (row[key] as string).length > 100000) throw new DialpadInsightRetry();
    }
    return { content: row.content as string, name: row.name as string, time: row.time as string, type: row.type as string, user_id: row.user_id as string };
  });
  // Preserve provider labels, including moments. Do not interpret unknown types as speech.
  const text = lines.filter(l => l.content.trim()).map(l => `[${l.type}] ${l.time} ${l.name}: ${l.content}`).join("\n");
  return { text, lines };
}

/** Caller supplies a verified inbox payload; raw external requests must never call this. */
export async function ingestDialpadInsights(options: {
  client: SupabaseClient<DialpadInsightsDatabase>; orgId: string; providerCallId: string;
  state: string; payload: unknown; apiKey: string; fetchImpl?: typeof fetch;
}): Promise<void> {
  if (!["call_transcription", "recap_summary"].includes(options.state)) return;
  try {
    const payload = options.payload as Record<string, unknown>;
    if (!payload || String(payload.call_id) !== options.providerCallId || payload.state !== options.state ||
        !/^[1-9]\d*$/.test(options.providerCallId) || !Number.isSafeInteger(payload.event_timestamp) || Number(payload.event_timestamp) < 0) throw new DialpadInsightRetry();
    const activity = await options.client.from("call_activities").select("id").eq("org_id", options.orgId)
      .eq("provider", "dialpad").eq("provider_call_id", options.providerCallId).maybeSingle();
    if (activity.error || !activity.data) throw new DialpadInsightRetry();
    let text: string; let lines: TranscriptLine[] | null = null;
    if (options.state === "recap_summary") {
      if (typeof payload.recap_summary !== "string" || payload.recap_summary.length > 1000000) throw new DialpadInsightRetry();
      text = payload.recap_summary;
    } else {
      if (!options.apiKey.trim() || /[\r\n]/.test(options.apiKey)) throw new DialpadInsightRetry();
      const response = await (options.fetchImpl ?? fetch)(`https://dialpad.com/api/v2/transcripts/${options.providerCallId}`, {
        headers: { Authorization: `Bearer ${options.apiKey}` }, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10000),
      });
      if (!response.ok || !response.body) throw new DialpadInsightRetry();
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length;
          if (size > 4000000) throw new DialpadInsightRetry(); chunks.push(part.value); }
      } finally { void reader.cancel().catch(() => undefined); }
      ({ text, lines } = parseDialpadTranscript(JSON.parse(Buffer.concat(chunks).toString("utf8")), options.providerCallId));
    }
    const stored = await options.client.rpc("fn_store_dialpad_insight", {
      p_org_id: options.orgId, p_call_id: options.providerCallId, p_kind: options.state === "call_transcription" ? "transcript" : "summary",
      p_event_ms: Number(payload.event_timestamp), p_text: text, p_lines: lines,
    });
    if (stored.error || stored.data !== true) throw new DialpadInsightRetry();
  } catch { throw new DialpadInsightRetry(); }
}
