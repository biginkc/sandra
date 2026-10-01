import "server-only";

import type { CallingConfig } from "./contract";

export type DirectCallEnv = Record<string, string | undefined>;

export const NORMAL_CALL_TIME_LIMIT_SECS = 7200;
export const PILOT_CALL_TIME_LIMIT_MIN_SECS = 30;
export const PILOT_CALL_TIME_LIMIT_MAX_SECS = 180;

export type TelnyxDirectSettings = {
  apiKey: string;
  connectionId: string;
  appId: string;
  webhookPublicKey: string;
  callerIdE164: string;
};

const E164 = /^\+[1-9]\d{7,14}$/;

export function pilotUserIds(env: DirectCallEnv = process.env): Set<string> {
  return new Set(
    (env.DIRECT_CALL_PILOT_USER_IDS ?? "")
      .split(",")
      .map((id) => id.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** All Telnyx settings, or null when anything is missing/invalid. */
export function readTelnyxDirectSettings(env: DirectCallEnv = process.env): TelnyxDirectSettings | null {
  const apiKey = env.TELNYX_DIRECT_API_KEY?.trim();
  const connectionId = env.TELNYX_DIRECT_CONNECTION_ID?.trim();
  const appId = env.TELNYX_DIRECT_APP_ID?.trim();
  const webhookPublicKey = env.TELNYX_DIRECT_WEBHOOK_PUBLIC_KEY?.trim();
  const callerIdE164 = env.DIRECT_CALL_CALLER_ID_E164?.trim();
  if (!apiKey || !connectionId || !appId || !webhookPublicKey || !callerIdE164) return null;
  if (!E164.test(callerIdE164)) return null;
  return { apiKey, connectionId, appId, webhookPublicKey, callerIdE164 };
}

export function isPilotUser(userId: string, env: DirectCallEnv = process.env): boolean {
  return pilotUserIds(env).has(userId.trim().toLowerCase());
}

/**
 * Set only after the live test proves the browser connection cannot place outbound calls.
 * Without it no browser token is issued and no direct call can start.
 */
export function isContainmentVerified(env: DirectCallEnv = process.env): boolean {
  return env.DIRECT_CALL_CONTAINMENT_VERIFIED?.trim() === "true";
}

/**
 * The normal direct-call limit remains 7,200 seconds. A bounded pilot limit is an explicit opt-in:
 * when configured it must be an integer in the provider-safe 30..180 second range. Invalid values
 * return null so the direct transport fails closed instead of silently widening the call window.
 */
export function readDirectCallTimeLimitSecs(env: DirectCallEnv = process.env): number | null {
  if (env.DIRECT_CALL_TIME_LIMIT_SECS === undefined) return NORMAL_CALL_TIME_LIMIT_SECS;
  const raw = env.DIRECT_CALL_TIME_LIMIT_SECS.trim();
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < PILOT_CALL_TIME_LIMIT_MIN_SECS || value > PILOT_CALL_TIME_LIMIT_MAX_SECS) return null;
  return value;
}

/** "telnyx_direct" only for an allow-listed pilot user with every env var set and containment verified. */
export function resolveCallingConfig(userId: string | null | undefined, env: DirectCallEnv = process.env): CallingConfig {
  if (!userId || !isContainmentVerified(env) || !isPilotUser(userId, env) || !readTelnyxDirectSettings(env) || readDirectCallTimeLimitSecs(env) === null) {
    return { transport: "default" };
  }
  return { transport: "telnyx_direct" };
}
