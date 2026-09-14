import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";

import { getEsignCredentials } from "@/lib/esign/credentials";
import { createDropboxSignProvider } from "@/lib/esign/dropbox-sign";
import {
  ESIGN_STUCK_SEND_MIN_AGE_MS,
  ESIGN_UNKNOWN_SEND_RESOLUTION_MIN_AGE_MS,
  ESIGN_UNKNOWN_SEND_ZERO_OBSERVATION_THRESHOLD,
  lookupAfterVerifiedProviderProbe,
  reconcileStuckEsignSends,
  type StuckEsignSend,
} from "@/lib/esign/stuck-send-reconciliation";
import { reportError } from "@/lib/errors/report";
import { ensureSentryServerClient } from "@/lib/errors/sentry-server-client";
import { cronResponseFailed, runMonitoredCron } from "@/lib/errors/cron-monitor";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

export const maxDuration = 60;
const PROVIDER_LOOKUP_TIMEOUT_MS = 10_000;
const RECONCILIATION_BUDGET_MS = 45_000;
const ZERO_RESULT_EVENT_TYPE = "esign_send_provider_zero_result";
const ESIGN_SENDING_SIGNAL = "esign_sending_stale";
const ESIGN_UNKNOWN_SIGNAL = "esign_send_unknown_stale";
const OBSERVATION_LIMIT = 10;

async function observeEsignSignal(
  admin: ReturnType<typeof createAdminClient>,
  kind: string,
  sourceId: string,
  active: boolean,
) {
  const { data, error } = await admin.rpc("observe_sentry_anomaly", {
    p_signal_kind: kind, p_source_id: sourceId, p_is_active: active,
  });
  if (error) throw error;
  const claim = data && typeof data === "object" && !Array.isArray(data)
    ? data as { decision?: unknown; claim_token?: unknown } : null;
  if (!claim || typeof claim.claim_token !== "string") return;
  let delivered = false;
  try {
    if (ensureSentryServerClient()) {
      if (claim.decision === "recovered") {
        reportError(new Error(`Sandra operational state recovered: ${kind}`), {
          tags: { surface: "cron_esign_state_observer", kind: "state", operation: kind, outcome: "recovered" },
        });
      } else {
        reportError(new Error(`Sandra operational state: ${kind}`), {
          tags: { surface: "cron_esign_state_observer", kind: "state", operation: kind, outcome: "active" },
        });
      }
      delivered = await Sentry.flush(2_000);
    }
  } finally {
    const { error: ackError } = await admin.rpc("ack_sentry_anomaly", {
      p_signal_kind: kind, p_source_id: sourceId,
      p_claim_token: claim.claim_token, p_delivered: delivered,
    });
    if (ackError) throw ackError;
  }
}

async function observeEsignStates(
  admin: ReturnType<typeof createAdminClient>,
  observerDeadline: number,
) {
  // Scan active claims first; a capped recovery list cannot prove absence.
  for (const [kind, state, age] of [
    [ESIGN_SENDING_SIGNAL, "sending", ESIGN_STUCK_SEND_MIN_AGE_MS],
    [ESIGN_UNKNOWN_SIGNAL, "send_unknown", ESIGN_UNKNOWN_SEND_RESOLUTION_MIN_AGE_MS],
  ] as const) {
    const { data: rows, error } = await admin.from("sentry_anomaly_ledger")
      .select("source_id").eq("signal_kind", kind).eq("is_active", true)
      .order("last_observed_at", { ascending: true }).limit(OBSERVATION_LIMIT);
    if (error) throw error;
    for (const row of rows ?? []) {
      if (Date.now() >= observerDeadline) return;
      const { data: request, error: requestError } = await admin.from("esign_requests")
        .select("delivery_state,delivery_state_entered_at,sign_request_id")
        .eq("id", row.source_id).maybeSingle();
      if (requestError) throw requestError;
      const active = !!request && request.delivery_state === state
        && !request.sign_request_id
        && Date.parse(request.delivery_state_entered_at) < Date.now() - age;
      // Active observations rotate the last_observed_at cursor, preventing
      // the first page from starving later incidents or recoveries.
      await observeEsignSignal(admin, kind, row.source_id, active);
    }
  }
  if (Date.now() >= observerDeadline) return;
  const { data: unobserved, error: unobservedError } = await admin.rpc(
    "list_unobserved_esign_sentry_anomalies", { p_limit: OBSERVATION_LIMIT },
  );
  if (unobservedError) throw unobservedError;
  for (const row of unobserved ?? []) {
    if (Date.now() >= observerDeadline) return;
    const kind = row.state === "sending" ? ESIGN_SENDING_SIGNAL : ESIGN_UNKNOWN_SIGNAL;
    await observeEsignSignal(admin, kind, row.request_id, true);
  }
}

async function handle(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET not configured" },
      { status: 500 },
    );
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return runMonitoredCron(
    "sandra-esign-send-reconciliation",
    { schedule: { type: "crontab", value: "3-59/5 * * * *" }, checkinMargin: 2, maxRuntime: 1 },
    async () => {
  try {
    const deadline = Date.now() + RECONCILIATION_BUDGET_MS;
    const admin = createAdminClient();
    // Observation uses the same capped, read-only candidate query as recovery.
    // Keep these counts separate from provider outcomes: a lookup can fail or
    // time out while the ambiguous business state remains unresolved.
    let observedSending = 0;
    let observedUnknown = 0;
    let observationCapped = false;
    const observedCandidates: { id: string; state: string; updatedAt: string }[] = [];
    const summary = await reconcileStuckEsignSends({
      listCandidates: async ({ staleBefore, limit }) => {
        const unknownStaleBefore = new Date(
          staleBefore.getTime() +
            ESIGN_STUCK_SEND_MIN_AGE_MS -
            ESIGN_UNKNOWN_SEND_RESOLUTION_MIN_AGE_MS,
        );
        const { data, error } = await admin
          .from("esign_requests")
          .select("id,org_id,property_id,test_mode,delivery_state,updated_at")
          .in("delivery_state", ["sending", "send_unknown"])
          .is("sign_request_id", null)
          .or(
            [
              `and(delivery_state.eq.sending,updated_at.lt.${staleBefore.toISOString()})`,
              `and(delivery_state.eq.send_unknown,updated_at.lt.${unknownStaleBefore.toISOString()})`,
            ].join(","),
          )
          .order("updated_at", { ascending: true })
          .limit(limit);
        if (error) throw error;
        observedSending = (data ?? []).filter((row) => row.delivery_state === "sending").length;
        observedUnknown = (data ?? []).filter((row) => row.delivery_state === "send_unknown").length;
        observationCapped = (data ?? []).length >= limit;
        for (const row of data ?? []) observedCandidates.push({
          id: row.id, state: row.delivery_state, updatedAt: row.updated_at,
        });
        return (data ?? []).flatMap((row) => {
          if (
            row.delivery_state !== "sending" &&
            row.delivery_state !== "send_unknown"
          ) {
            return [];
          }
          return [{
            id: row.id,
            orgId: row.org_id,
            propertyId: row.property_id,
            testMode: row.test_mode,
            deliveryState: row.delivery_state,
            updatedAt: new Date(row.updated_at),
          }];
        });
      },
      lookupProviderRequest: async (candidate: StuckEsignSend) => {
        const credentials = await getEsignCredentials(candidate.orgId);
        if (!credentials) throw new Error("eSign credentials unavailable.");
        const provider = createDropboxSignProvider({
          apiKey: credentials.apiKey,
          clientId: credentials.clientId,
        });
        const { data: reference, error: referenceError } = await admin
          .from("esign_requests")
          .select("id,sign_request_id")
          .eq("org_id", candidate.orgId)
          .eq("test_mode", candidate.testMode)
          .not("sign_request_id", "is", null)
          .neq("id", candidate.id)
          .order("sent_at", { ascending: false, nullsFirst: false })
          .limit(1)
          .maybeSingle();
        if (referenceError) throw referenceError;
        const referenceSignRequestId = reference?.sign_request_id;
        return withLookupTimeout(async (signal) => {
          return lookupAfterVerifiedProviderProbe({
            candidate,
            reference: reference && referenceSignRequestId
              ? {
                  localRequestId: reference.id,
                  providerRequestId: referenceSignRequestId,
                }
              : null,
            find: (localRequestId, testMode) =>
              provider.findSignatureRequestIdsByLocalRequestId(
                localRequestId,
                testMode,
                signal,
              ),
          });
        });
      },
      markOutcome: async (outcome) => {
        if (outcome.deliveryState === "sent") {
          const { error } = await admin.rpc("attach_esign_request_provider_delivery", {
            p_org_id: outcome.orgId,
            p_request_id: outcome.id,
            p_provider_request_id: outcome.providerRequestId,
            p_resolution_source: outcome.resolutionSource,
            p_evidence: {
              ...outcome.evidence,
              localRequestId: outcome.id,
            } as Json,
          });
          if (error?.code === "55000") return "raced" as const;
          if (error) throw error;
          return "updated" as const;
        }
        if (outcome.deliveryState === "failed") {
          const { error } = await admin.rpc("resolve_esign_send_unknown_not_sent", {
            p_org_id: outcome.orgId,
            p_request_id: outcome.id,
            p_actor_id: null,
            p_resolution_source: outcome.resolutionSource ?? "automatic",
            p_error_message:
              outcome.safeErrorMessage ?? "PROVIDER_SEND_NOT_FOUND",
            p_evidence: (outcome.evidence ?? {}) as Json,
          });
          if (error?.code === "55000") return "raced" as const;
          if (error) throw error;
          return "updated" as const;
        }
        const { error } = await admin.rpc("mark_esign_request_send_outcome", {
          p_org_id: outcome.orgId,
          p_request_id: outcome.id,
          p_delivery_state: outcome.deliveryState,
          p_error_message: outcome.safeErrorMessage,
        });
        if (error?.code === "55000") return "raced" as const;
        if (error) throw error;
        return "updated" as const;
      },
      recordZeroResult: async (input) => {
        const observedAt = input.observedAt.toISOString();
        const payload = {
          request_id: input.id,
          delivery_state: input.deliveryState,
          observed_at: observedAt,
          positive_control: "passed",
          minimum_unknown_age_ms: ESIGN_UNKNOWN_SEND_RESOLUTION_MIN_AGE_MS,
          zero_observation_threshold:
            ESIGN_UNKNOWN_SEND_ZERO_OBSERVATION_THRESHOLD,
        };
        const { error: insertError } = await admin.from("lead_events").insert({
          org_id: input.orgId,
          property_id: input.propertyId,
          actor_type: "system",
          actor_id: null,
          event_type: ZERO_RESULT_EVENT_TYPE,
          payload,
          source_type: null,
          source_id: null,
          created_at: observedAt,
        });
        if (insertError) throw insertError;
        const { data, error: countError } = await admin
          .from("lead_events")
          .select("created_at")
          .eq("org_id", input.orgId)
          .eq("property_id", input.propertyId)
          .eq("event_type", ZERO_RESULT_EVENT_TYPE)
          .contains("payload", {
            request_id: input.id,
            positive_control: "passed",
          })
          .gte("created_at", input.updatedAt.toISOString())
          .order("created_at", { ascending: true })
          .limit(ESIGN_UNKNOWN_SEND_ZERO_OBSERVATION_THRESHOLD);
        if (countError) throw countError;
        return {
          consecutiveCompleteZeroCount: data?.length ?? 0,
          firstObservedAt: data?.[0]?.created_at
            ? new Date(data[0].created_at)
            : null,
        };
      },
      reportOutcomeError: (error, candidate) => reportError(error, {
        tags: { surface: "cron_esign_send_reconciliation_outcome" },
        extra: { requestId: candidate.id, orgId: candidate.orgId },
      }),
      reportLookupError: (error, candidate) => reportError(error, {
        tags: { surface: "cron_esign_send_reconciliation_lookup" },
        extra: { requestId: candidate.id, orgId: candidate.orgId },
      }),
      shouldContinue: () => Date.now() < deadline,
    });
    // Observe after reconciliation so successfully repaired rows do not alert.
    try {
      // Reserve five seconds for the response and platform teardown. A
      // timeout leaves unacked leases retryable at the next cron invocation.
      const observerDeadline = deadline + 10_000;
      for (const candidate of observedCandidates) {
        if (Date.now() >= observerDeadline) break;
        const kind = candidate.state === "sending" ? ESIGN_SENDING_SIGNAL : ESIGN_UNKNOWN_SIGNAL;
        const age = candidate.state === "sending"
          ? ESIGN_STUCK_SEND_MIN_AGE_MS : ESIGN_UNKNOWN_SEND_RESOLUTION_MIN_AGE_MS;
        const { data: current, error } = await admin.from("esign_requests")
          .select("delivery_state,delivery_state_entered_at,sign_request_id")
          .eq("id", candidate.id).maybeSingle();
        if (error) throw error;
        if (current?.delivery_state === candidate.state && !current.sign_request_id
          && Date.parse(current.delivery_state_entered_at) < Date.now() - age) {
          await observeEsignSignal(admin, kind, candidate.id, true);
        }
      }
      if (Date.now() < observerDeadline) {
        await observeEsignStates(admin, observerDeadline);
      }
    } catch (observerError) {
      reportError(observerError, { tags: { surface: "cron_esign_state_observer_failure" } });
    }
    return NextResponse.json({
      ok: summary.lookupErrors === 0 && summary.errors === 0,
      ...summary,
      observed_sending_stale: observedSending,
      observed_send_unknown_stale: observedUnknown,
      observation_capped: observationCapped,
    });
  } catch (error) {
    reportError(error, { tags: { surface: "cron_esign_send_reconciliation" } });
    return NextResponse.json(
      { error: "eSign send reconciliation failed." },
      { status: 500 },
    );
  }
    },
    cronResponseFailed,
  );
}

async function withLookupTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const lookupPromise = operation(controller.signal);
  void lookupPromise.catch(() => undefined);
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new DOMException("Provider lookup deadline exceeded.", "AbortError"));
    }, PROVIDER_LOOKUP_TIMEOUT_MS);
  });
  return Promise.race([lookupPromise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export const GET = handle;
export const POST = handle;
