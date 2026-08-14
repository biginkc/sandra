import { ProviderError } from "@/lib/errors/classes";
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
    }
  | {
      /** Codex round 8: the caller-supplied deadline `signal` (see below)
       *  fired mid-call — the underlying fetch was torn down before we know
       *  whether Sendillo actually received/sent the message (see
       *  `SendilloMessagingProvider.sendSms`'s doc comment: an abort "still
       *  throws the same `ProviderError` as any other network failure").
       *  Deliberately its OWN reason, never folded into `provider_error`: a
       *  real `provider_error` means Sendillo was reached and responded
       *  with a failure, safe to treat as a confirmed non-delivery; an
       *  abort proves nothing either way. Callers (`deliverSms` in
       *  reminders.ts) must never treat this as a confirmed non-delivery —
       *  see `ReminderDeliveryOutcome`'s `aborted_ambiguous` variant.
       *
       *  Codex round 12 (finding 1): also returned for a non-abort
       *  transport failure mid-flight (`fetch()` itself rejected, no HTTP
       *  response ever received) and for a 2xx response with no
       *  reconcilable message id — both are the same "transmission may
       *  have started, no provable receipt" uncertainty an abort is, so
       *  they get the identical never-retryable treatment. See
       *  sendillo.ts's `sendSms` doc comment for the full classification. */
      ok: false;
      reason: "aborted_ambiguous";
      message: string;
    }
  | {
      /** Codex round 10 (finding 4): the caller-supplied deadline `signal`
       *  was ALREADY aborted before `SendilloMessagingProvider.sendSms`
       *  ever issued the fetch — see that method's doc comment for why this
       *  is a strictly stronger guarantee than `aborted_ambiguous` above:
       *  no request ever left this process, so this is PROVABLY
       *  non-delivery, not merely "we stopped waiting." Callers should
       *  treat this the same as a definite `provider_error` — a normal,
       *  retryable failure, never routed through the ambiguous-outcome
       *  handling `aborted_ambiguous` requires. */
      ok: false;
      reason: "not_sent";
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
    // Codex round 8, extended round 9 (finding 1): distinguish an abort
    // (deadline fired mid-call, or the provider's own internal timeout
    // fired, or a test simulating either) from a genuine provider rejection
    // BEFORE the generic report/return below runs. Checked three ways,
    // since no single one is reliable across every path:
    //  1. `err.name === "AbortError"` — a raw aborted fetch/DOMException.
    //  2. `error instanceof ProviderError && error.details?.isAbort` —
    //     `sendillo.ts` re-wraps an AbortError into a `ProviderError`
    //     (losing the original error's `name`) but now preserves abort
    //     provenance via `details.isAbort`. This is the ONLY signal that
    //     catches Sendillo's own internal `DEFAULT_SEND_TIMEOUT_MS` firing
    //     while `params.signal` (this call's external deadline) is still
    //     live — check 3 below stays false in that case, since nothing
    //     external ever aborted.
    //  3. `params.signal?.aborted` at catch time — true even when neither
    //     of the above fires (belt-and-suspenders for the external-deadline
    //     path).
    // Round 9 deliberately maps EITHER an internal or an external abort to
    // the SAME `aborted_ambiguous` outcome: from this function's caller's
    // perspective, "Sendillo's own clock ran out" and "our deadline ran
    // out" are equally non-evidence of delivery — see sendillo.ts's sendSms
    // doc comment.
    //
    // Codex round 10 (finding 4): checked BEFORE the general `aborted`
    // check below — `sendillo.ts` throws with `details.notSent = true`
    // specifically when `params.signal` was ALREADY aborted before any
    // fetch was attempted, which would otherwise also satisfy `aborted`'s
    // third check (`params.signal?.aborted === true`) and get misclassified
    // as merely ambiguous. This is provably not sent, not merely abandoned
    // mid-flight — see `RepSmsSendResult`'s `not_sent` variant above.
    if (error instanceof ProviderError && error.details?.notSent === true) {
      reportError(error, {
        tags: { surface: "rep_sms_send_not_sent" },
        extra: { to: params.to },
      });
      return {
        ok: false,
        reason: "not_sent",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    // Codex round 12 (finding 1): `transportFailure` (a non-abort `fetch()`
    // rejection — connection reset, DNS blip, socket error, no HTTP
    // response ever received) and `acceptedWithoutId` (a 2xx response with
    // no reconcilable id) are BOTH transmission-started-outcome-unproven
    // cases, same as an abort — see sendillo.ts's `sendSms` doc comment for
    // why neither proves non-delivery. Folded into the same `aborted`
    // check (and the same `aborted_ambiguous` result) rather than a new
    // reason: every downstream consumer (`deliverSms` in reminders.ts)
    // already treats `aborted_ambiguous` as "never retryable, fence into
    // timeout_ambiguous" — exactly the posture these two cases need too.
    const aborted =
      (error instanceof Error && error.name === "AbortError") ||
      (error instanceof ProviderError &&
        (error.details?.isAbort === true ||
          error.details?.transportFailure === true ||
          error.details?.acceptedWithoutId === true)) ||
      params.signal?.aborted === true;
    if (aborted) {
      // Distinct tag from the ordinary provider-error report below — this
      // isn't "Sendillo said no," it's "we gave up waiting," and dashboards
      // must not conflate the two.
      reportError(error, {
        tags: { surface: "rep_sms_send_aborted_ambiguous" },
        extra: { to: params.to },
      });
      return {
        ok: false,
        reason: "aborted_ambiguous",
        message: error instanceof Error ? error.message : String(error),
      };
    }
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
