import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Opaque, signed, short-lived handle for a Search selection that must survive a round trip
 * (skip-trace preflight -> CASS launch). The token carries only the FILTERS (never an id list),
 * is bound to the user, and is re-resolved server-side on use.
 */
const TTL_MS = 10 * 60 * 1000;

function secret(): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("Selection tokens need a server secret.");
  return `search-selection-token:v1:${key}`;
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

export function mintSelectionToken(args: { userId: string; filters: unknown; now?: number }): string {
  const payload = Buffer.from(
    JSON.stringify({ u: args.userId, f: args.filters, e: (args.now ?? Date.now()) + TTL_MS }),
  ).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function readSelectionToken(
  token: string,
  userId: string,
  now = Date.now(),
): { ok: true; filters: unknown } | { ok: false } {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return { ok: false };
  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false };
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { u?: string; f?: unknown; e?: number };
    if (parsed.u !== userId || typeof parsed.e !== "number" || parsed.e < now) return { ok: false };
    return { ok: true, filters: parsed.f };
  } catch {
    return { ok: false };
  }
}
