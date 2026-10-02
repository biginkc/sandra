import "server-only";

import { createHmac } from "node:crypto";

import type { DirectCallEnv } from "./config";
import type { DirectCallFullRow } from "./store";

/**
 * The presence service is part of the direct-call safety boundary.  A missing or
 * malformed setting is intentionally represented as null so the caller can fail
 * closed before reserving a provider Dial.
 */
export type DirectWatchdogConfig = {
  presenceUrl: string;
  tokenSecret: string;
  cleanupUrl: string;
  cleanupSecret: string;
};

function requiredUrl(value: string | undefined, protocols: readonly string[]): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    return protocols.includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
      ? url.toString().replace(/\/$/, "")
      : null;
  } catch {
    return null;
  }
}

function secret(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized && Buffer.byteLength(normalized, "utf8") >= 32 ? normalized : null;
}

export function readDirectWatchdogConfig(env: DirectCallEnv = process.env): DirectWatchdogConfig | null {
  const presenceUrl = requiredUrl(env.DIRECT_WATCHDOG_PRESENCE_URL, ["wss:", "ws:"]);
  const cleanupUrl = requiredUrl(env.DIRECT_WATCHDOG_CLEANUP_URL, ["https:", "http:"]);
  const tokenSecret = secret(env.DIRECT_WATCHDOG_TOKEN_SECRET ?? env.DIRECT_WATCHDOG_SECRET);
  const cleanupSecret = secret(env.DIRECT_WATCHDOG_CLEANUP_SECRET ?? env.DIRECT_WATCHDOG_SECRET);
  if (!presenceUrl || !cleanupUrl || !tokenSecret || !cleanupSecret) return null;
  return { presenceUrl, tokenSecret, cleanupUrl, cleanupSecret };
}

function encoded(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

/** Signed token is delivered as the first WebSocket message, never in the URL. */
export function createDirectWatchdogToken(row: DirectCallFullRow, userId: string, config: DirectWatchdogConfig, nowMs = Date.now()): string | null {
  if (!row.browser_leg_id || !row.browser_watchdog_session_id) return null;
  const createdAt = Date.parse(row.created_at);
  const limitMs = Math.min(Math.max(row.time_limit_secs, 30), 7200) * 1000;
  const expiresAtMs = Math.min(createdAt + limitMs + 60_000, nowMs + limitMs + 60_000);
  const claims = {
    callId: row.id,
    browserLegId: row.browser_leg_id,
    operatorUserId: userId,
    sessionId: row.browser_watchdog_session_id,
    expiresAtMs,
  };
  const body = encoded(JSON.stringify(claims));
  const signature = createHmac("sha256", config.tokenSecret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function signWatchdogCleanup(body: string, timestamp: string, secretValue: string): string {
  return createHmac("sha256", secretValue).update(`${timestamp}.${body}`).digest("base64url");
}
