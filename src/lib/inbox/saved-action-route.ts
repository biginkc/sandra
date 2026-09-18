import "server-only";

import { createClient } from "@/lib/supabase/server";
import { InvalidInboxActionError, parseInboxActionDefinition, type InboxActionDefinition } from "./action-definition";
import { isInboxPilotRequest, type InboxPilotAuthClient } from "./pilot-cohort";
import { isInboxSameOrigin } from "./same-origin";
import { createInboxSavedActionRepository, InboxSavedActionApiError, type InboxSavedActionClient } from "./saved-action-api";

const MAX_BODY_BYTES = 128 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const responseHeaders = { "cache-control": "private, no-store", vary: "Cookie, Authorization" };

type SavedActionRoute = "list" | "create" | "update" | "deactivate";

function invalid(status = 400, code = "invalid_saved_action"): never { throw new InboxSavedActionApiError(status, code); }
function record(value: unknown): Record<string, unknown> { if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(); return value as Record<string, unknown>; }

/** Parse JSON while rejecting duplicate object member names. JSON.parse alone
 * would silently keep the last duplicate, which would make strict envelopes
 * ambiguous at the route boundary. */
function parseJson(raw: string): unknown {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { invalid(); }
  const containers: (Set<string> | null)[] = [];
  const tokens = /"(?:\\[\s\S]|[^"\\])*"|[{}[\]]/g;
  for (const match of raw.matchAll(tokens)) {
    const token = match[0];
    if (token === "{") containers.push(new Set());
    else if (token === "[") containers.push(null);
    else if (token === "}" || token === "]") containers.pop();
    else {
      let next = match.index + token.length;
      while (/\s/.test(raw[next] ?? "") && next < raw.length) next++;
      if (raw[next] === ":") {
        const keys = containers[containers.length - 1];
        if (!keys) continue;
        let key: string;
        try { key = JSON.parse(token) as string; } catch { invalid(); }
        if (keys.has(key)) invalid();
        keys.add(key);
      }
    }
  }
  return value;
}

async function readBody(request: Request, signal: AbortSignal): Promise<string> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") invalid(415, "unsupported_media_type");
  const reader = request.body?.getReader();
  if (!reader) invalid(400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => { void reader.cancel().catch(() => { /* the stream may already be closed */ }); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      let abortListener: (() => void) | undefined;
      const aborted = new Promise<never>((_, reject) => {
        abortListener = () => reject(signal.reason ?? new DOMException("Request aborted", "AbortError"));
        signal.addEventListener("abort", abortListener, { once: true });
      });
      let part: ReadableStreamReadResult<Uint8Array>;
      try { part = await Promise.race([reader.read(), aborted]); }
      finally { if (abortListener) signal.removeEventListener("abort", abortListener); }
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BODY_BYTES) { cancel(); invalid(413, "body_too_large"); }
      chunks.push(part.value);
    }
  } finally { signal.removeEventListener("abort", cancel); reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { invalid(); }
}

function exact(row: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(row).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) invalid();
}

function name(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 120 || value.includes("\u0000")) invalid(400, "invalid_name");
  return value.trim();
}

function definition(value: unknown): InboxActionDefinition {
  try { return parseInboxActionDefinition(JSON.stringify(value)); }
  catch (error) { if (error instanceof InvalidInboxActionError) invalid(400, "invalid_definition"); throw error; }
}

function id(value: unknown): string { if (typeof value !== "string" || !UUID.test(value)) invalid(); return value; }

function errorResponse(error: unknown): Response {
  const status = error instanceof InboxSavedActionApiError ? error.status : error instanceof InvalidInboxActionError ? 400 : 503;
  const code = error instanceof InboxSavedActionApiError ? error.message : error instanceof InvalidInboxActionError ? "invalid_saved_action" : "saved_action_unavailable";
  return Response.json({ error: code }, { status, headers: responseHeaders });
}

/** CRUD transport for the personal saved-action repository. The route is
 * admission-gated before repository construction/RPC and never trusts the
 * browser for actor, organization, or action execution context. */
export async function inboxSavedActionRoute(request: Request, action: SavedActionRoute): Promise<Response> {
  if (process.env.INBOX_ACTIONS_SERVER_ENABLED !== "1") return Response.json({ error: "Not found" }, { status: 404, headers: responseHeaders });
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(20_000)]);
  try {
    const url = new URL(request.url);
    if (url.search || !isInboxSameOrigin(request)) throw new InboxSavedActionApiError(403, "request_forbidden");
    let row: Record<string, unknown> | undefined;
    if (action !== "list") { const raw = await readBody(request, signal); signal.throwIfAborted(); row = record(parseJson(raw)); }
    const client = await createClient();
    if (!(await isInboxPilotRequest(client as unknown as InboxPilotAuthClient))) return Response.json({ error: "Not found" }, { status: 404, headers: responseHeaders });
    const repository = createInboxSavedActionRepository(client as unknown as InboxSavedActionClient);
    if (action === "list") return Response.json({ items: await repository.list(signal) }, { headers: responseHeaders });
    if (action === "create") {
      exact(row!, ["name", "definition"]);
      return Response.json({ item: await repository.create(name(row!.name), definition(row!.definition), signal) }, { headers: responseHeaders });
    }
    if (action === "update") {
      exact(row!, ["id", "name", "definition"]);
      return Response.json({ item: await repository.update(id(row!.id), name(row!.name), definition(row!.definition), signal) }, { headers: responseHeaders });
    }
    exact(row!, ["id"]);
    return Response.json({ item: await repository.deactivate(id(row!.id), signal) }, { headers: responseHeaders });
  } catch (error) {
    return errorResponse(error);
  }
}
