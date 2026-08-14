import { reportError } from "@/lib/errors/report";
import { SendilloMessagingProvider } from "@/lib/messaging/providers/sendillo";

/**
 * Rep-facing appointment-reminder SMS. Deliberately a thin, direct client
 * over `SendilloMessagingProvider` — NOT the seller messaging registry
 * (no consent/suppression/campaign paths; those govern outbound-to-lead
 * messaging, and a reminder here is BMH-internal, rep-to-rep).
 *
 * Sender number is `REP_SMS_FROM_NUMBER` — a DIFFERENT env var from
 * `SENDILLO_FROM_NUMBER` (the seller-messaging default), reusing only the
 * provider's existing auth env var (`SENDILLO_API_KEY`). Fails CLOSED
 * server-side (never silently no-ops as "sent") when the env is absent or
 * the configured number isn't in Sendillo's purchased-number catalog — an
 * enabled `sms_reminder` DB row must never outlive what's actually
 * deliverable.
 *
 * Full plan: reactive-puzzling-crane.md v9, PR 3 "Rep SMS concrete".
 */

const CATALOG_CACHE_TTL_MS = 60_000;

type CatalogCache = {
  fromNumber: string;
  numbers: Set<string>;
  fetchedAt: number;
};

let catalogCache: CatalogCache | null = null;

export type RepSmsReadyResult =
  | { ready: true }
  | { ready: false; reason: "not_configured" | "number_not_in_catalog"; message: string };

export type RepSmsSendResult =
  | { ok: true; externalId: string }
  | {
      ok: false;
      reason: "not_configured" | "number_not_in_catalog" | "provider_error";
      message: string;
    };

function repSmsEnv(): { apiKey: string; fromNumber: string } | null {
  const apiKey = process.env.SENDILLO_API_KEY;
  const fromNumber = process.env.REP_SMS_FROM_NUMBER;
  if (!apiKey || !fromNumber) return null;
  return { apiKey, fromNumber };
}

async function purchasedNumberCatalog(
  apiKey: string,
  fromNumber: string,
): Promise<Set<string>> {
  const now = Date.now();
  if (
    catalogCache &&
    catalogCache.fromNumber === fromNumber &&
    now - catalogCache.fetchedAt < CATALOG_CACHE_TTL_MS
  ) {
    return catalogCache.numbers;
  }
  const provider = new SendilloMessagingProvider(apiKey, fromNumber);
  const list = await provider.listPurchasedNumbers();
  const numbers = new Set(list.map((entry) => entry.phoneE164));
  catalogCache = { fromNumber, numbers, fetchedAt: now };
  return numbers;
}

/**
 * Read-only preflight: env present AND the configured `REP_SMS_FROM_NUMBER`
 * is a number Sendillo's account actually owns. Cached per-process for
 * `CATALOG_CACHE_TTL_MS` (comfortably longer than one sweep's wall-clock
 * budget) so a sweep processing many reminders doesn't hit the catalog
 * endpoint once per row. Exported separately from `sendRepSmsReminder` so
 * the settings action can run the same check before allowing the
 * `sms_reminder` channel to be enabled.
 */
export async function checkRepSmsFromNumberReady(): Promise<RepSmsReadyResult> {
  const env = repSmsEnv();
  if (!env) {
    return {
      ready: false,
      reason: "not_configured",
      message: "REP_SMS_FROM_NUMBER or SENDILLO_API_KEY is not set.",
    };
  }

  let numbers: Set<string>;
  try {
    numbers = await purchasedNumberCatalog(env.apiKey, env.fromNumber);
  } catch (error) {
    reportError(error, { tags: { surface: "rep_sms_catalog_check" } });
    return {
      ready: false,
      reason: "number_not_in_catalog",
      message: "Could not verify the reminder SMS number with Sendillo.",
    };
  }

  if (!numbers.has(env.fromNumber)) {
    return {
      ready: false,
      reason: "number_not_in_catalog",
      message: `${env.fromNumber} is not in Sendillo's purchased-number catalog.`,
    };
  }

  return { ready: true };
}

export async function sendRepSmsReminder(params: {
  to: string;
  body: string;
  /** Codex round 7 (finding 1, item 5): the reminder sweep's per-delivery
   *  deadline, forwarded through to Sendillo's fetch call for best-effort
   *  cancellation. See `SendilloMessagingProvider.sendSms` for why this is
   *  cleanup only and doesn't change how a resulting error is interpreted. */
  signal?: AbortSignal;
}): Promise<RepSmsSendResult> {
  const ready = await checkRepSmsFromNumberReady();
  if (!ready.ready) {
    return { ok: false, reason: ready.reason, message: ready.message };
  }

  const env = repSmsEnv();
  // repSmsEnv() cannot be null here — checkRepSmsFromNumberReady() would
  // have already returned not_configured above.
  if (!env) {
    return {
      ok: false,
      reason: "not_configured",
      message: "REP_SMS_FROM_NUMBER or SENDILLO_API_KEY is not set.",
    };
  }

  const provider = new SendilloMessagingProvider(env.apiKey, env.fromNumber);
  try {
    const result = await provider.sendSms(
      {
        to: params.to,
        body: params.body,
        from: env.fromNumber,
      },
      { signal: params.signal },
    );
    return { ok: true, externalId: result.externalId };
  } catch (error) {
    reportError(error, {
      tags: { surface: "rep_sms_send" },
      extra: { to: params.to },
    });
    return {
      ok: false,
      reason: "provider_error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Test-only: clears the module-level purchased-number catalog cache. */
export function __resetRepSmsCatalogCacheForTests(): void {
  catalogCache = null;
}
