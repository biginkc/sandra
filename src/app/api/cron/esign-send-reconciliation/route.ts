import { NextResponse } from "next/server";

import {
  configuredDropboxSignEmbeddedDomain,
  getEsignCredentials,
} from "@/lib/esign/credentials";
import { createDropboxSignProvider } from "@/lib/esign/dropbox-sign";
import {
  lookupAfterVerifiedProviderProbe,
  reconcileStuckEsignSends,
  type StuckEsignSend,
} from "@/lib/esign/stuck-send-reconciliation";
import { reportError } from "@/lib/errors/report";
import { createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 60;
const PROVIDER_LOOKUP_TIMEOUT_MS = 10_000;
const RECONCILIATION_BUDGET_MS = 45_000;

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
  try {
    const deadline = Date.now() + RECONCILIATION_BUDGET_MS;
    const admin = createAdminClient();
    const summary = await reconcileStuckEsignSends({
      listCandidates: async ({ staleBefore, limit }) => {
        const { data, error } = await admin
          .from("esign_requests")
          .select("id,org_id,test_mode")
          .eq("delivery_state", "sending")
          .is("sign_request_id", null)
          .lt("updated_at", staleBefore.toISOString())
          .order("updated_at", { ascending: true })
          .limit(limit);
        if (error) throw error;
        return (data ?? []).map((row) => ({
          id: row.id,
          orgId: row.org_id,
          testMode: row.test_mode,
        }));
      },
      lookupProviderRequest: async (candidate: StuckEsignSend) => {
        const credentials = await getEsignCredentials(candidate.orgId);
        if (!credentials) throw new Error("eSign credentials unavailable.");
        const provider = createDropboxSignProvider({
          apiKey: credentials.apiKey,
          clientId: credentials.clientId,
          expectedDomain: configuredDropboxSignEmbeddedDomain(),
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
    return NextResponse.json({
      ok: summary.lookupErrors === 0 && summary.errors === 0,
      ...summary,
    });
  } catch (error) {
    reportError(error, { tags: { surface: "cron_esign_send_reconciliation" } });
    return NextResponse.json(
      { error: "eSign send reconciliation failed." },
      { status: 500 },
    );
  }
}

async function withLookupTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    PROVIDER_LOOKUP_TIMEOUT_MS,
  );
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export const GET = handle;
export const POST = handle;
