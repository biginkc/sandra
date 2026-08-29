"use server";

import { start } from "workflow/api";

import { isAdminEmail } from "@/lib/auth/allowlist";
import { listAdminUserIds } from "@/lib/auth/admins";
import { CASS_COST_PER_LOOKUP_USD } from "@/lib/enrichment/cass-job";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import { LEAD_EVENT_TYPES, recordLeadEvents } from "@/lib/events";
import {
  dispatchJobCompleted,
  dispatchSkipTraceRequested,
} from "@/lib/notifications/dispatch";
import { createClient } from "@/lib/supabase/server";
import type { Json } from "@/lib/supabase/types";
import { skipTraceSubmitWorkflow } from "@/workflows/skip-trace-submit";

import {
  normalizeAddress,
  normalizeAddressForMatch,
  readCacheMany,
  reusableCachedResult,
} from "./cache";
import {
  buildSkipTraceEligibilityAudit,
  resolveSkipTraceEligibility,
  skipTraceAudienceDescription,
  skipTraceAudienceTitle,
} from "./eligibility";
import { getSkipTraceProvider } from "./registry";
import { tracerfyBatchCreditLimit } from "./providers/tracerfy";
import type { SkipTraceInput } from "./types";

/** Max rows per single Tracefy POST. Their server rejects request
 *  bodies past ~2.5 MB with a generic HTML 400 before any field
 *  validation runs (hit live 2026-06-12 with a 12,282-row batch ≈ 3 MB).
 *  4,000 rows ≈ 0.9 MB keeps comfortable headroom. Selections larger
 *  than this are auto-split into multiple part-jobs — each with its own
 *  Tracefy queue id, so the existing per-job webhook/poll finalization
 *  works unchanged. This is a wire-format constraint, NOT a volume cap.
 */
const PROVIDER_BATCH_MAX = 4_000;

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

export type SkipTraceCreditStatus =
  "sufficient" | "insufficient" | "unavailable";

export type SkipTracePreflight = {
  requested: number;
  eligible: number;
  cassVerified: number;
  cassUnverified: number;
  notEligible: number;
  killSwitchSkipped: number;
  tracefyCreditsRequired: number;
  tracefyCreditsAvailable: number | null;
  tracefyCreditStatus: SkipTraceCreditStatus;
  canLaunchSkipTrace: boolean;
  estimatedCassVerificationCostUsd: number;
  cassVerificationPropertyIds: string[];
};

type InternalSkipTracePreflight = SkipTracePreflight & {
  eligiblePropertyIds: string[];
  orgId: string | null;
  hasMixedOrganizations: boolean;
  tracefyCreditsRequiredByPart: number[];
};

function tracefyCreditsRequired(providerBoundParts: SkipTraceInput[][]): {
  total: number;
  byPart: number[];
} {
  const byPart: number[] = [];
  for (const part of providerBoundParts) {
    if (part.length === 0) {
      byPart.push(0);
      continue;
    }
    if (part.length === 1) {
      byPart.push(5);
      continue;
    }
    const uniqueByAddress = new Map<string, SkipTraceInput>();
    for (const input of part) {
      const key = normalizeAddressForMatch(input);
      if (!uniqueByAddress.has(key)) uniqueByAddress.set(key, input);
    }
    byPart.push(tracerfyBatchCreditLimit([...uniqueByAddress.values()]));
  }
  return { total: byPart.reduce((sum, value) => sum + value, 0), byPart };
}

async function getTracefyCreditState(required: number): Promise<{
  available: number | null;
  status: SkipTraceCreditStatus;
}> {
  if (required <= 0) {
    return { available: null, status: "sufficient" };
  }

  try {
    const provider = getSkipTraceProvider();
    if (!provider) return { available: null, status: "unavailable" };
    const available = await provider.getBalance();
    return {
      available,
      status: available >= required ? "sufficient" : "insufficient",
    };
  } catch (e) {
    reportError(e, { tags: { surface: "skip_trace_credit_preflight" } });
    return { available: null, status: "unavailable" };
  }
}

async function buildSkipTracePreflight(
  supabase: SupabaseServerClient,
  propertyIds: string[],
): Promise<InternalSkipTracePreflight> {
  const rows: Array<{
    id: string;
    org_id: string | null;
    address: string;
    city: string | null;
    state: string;
    zip: string | null;
    homeowner_contact_id: string | null;
    skip_trace_disabled: boolean;
    cass_status: string;
  }> = [];

  for (let i = 0; i < propertyIds.length; i += 500) {
    const { data, error } = await supabase
      .from("properties")
      .select(
        "id, org_id, address, city, state, zip, homeowner_contact_id, skip_trace_disabled, cass_status",
      )
      .in("id", propertyIds.slice(i, i + 500));
    if (error) {
      throw new Error(error.message);
    }
    if (data) rows.push(...data);
  }

  const allowed = rows.filter(
    (p) => !p.skip_trace_disabled && p.cass_status === "verified",
  );
  const cassVerified = rows.filter((p) => p.cass_status === "verified");
  const cassUnverified = rows.filter((p) => p.cass_status !== "verified");
  const cassVerificationCandidates = cassUnverified.filter(
    (p) => !p.skip_trace_disabled && p.cass_status !== "verified",
  );
  const killSwitched = rows.filter((p) => p.skip_trace_disabled);
  const eligibleOrgIds = new Set(
    allowed.map((property) => property.org_id).filter(Boolean),
  );
  const hasMixedOrganizations = eligibleOrgIds.size > 1;

  const reusablePropertyIds = new Set<string>();
  const provider = getSkipTraceProvider();
  const eligibleOrgId =
    eligibleOrgIds.size === 1 ? ([...eligibleOrgIds][0] ?? null) : null;
  if (provider && eligibleOrgId) {
    const normalizedByPropertyId = new Map(
      allowed.map((property) => [
        property.id,
        normalizeAddress({
          address: property.address,
          city: property.city,
          state: property.state,
          zip: property.zip,
        }),
      ]),
    );
    const cache = await readCacheMany(
      supabase,
      eligibleOrgId,
      provider.providerId,
      [...normalizedByPropertyId.values()],
    );
    for (const property of allowed) {
      const normalized = normalizedByPropertyId.get(property.id);
      const cached = normalized ? cache.get(normalized) : null;
      if (cached && reusableCachedResult(provider, cached, property.id)) {
        reusablePropertyIds.add(property.id);
      }
    }
  }

  const providerBoundParts: SkipTraceInput[][] = [];
  for (let i = 0; i < allowed.length; i += PROVIDER_BATCH_MAX) {
    providerBoundParts.push(
      allowed
        .slice(i, i + PROVIDER_BATCH_MAX)
        .filter((property) => !reusablePropertyIds.has(property.id))
        .map((property) => ({
          propertyId: property.id,
          address: property.address,
          city: property.city ?? "",
          state: property.state,
          zip: property.zip,
        })),
    );
  }
  const required = tracefyCreditsRequired(providerBoundParts);
  const creditState = await getTracefyCreditState(required.total);

  return {
    requested: propertyIds.length,
    eligible: allowed.length,
    cassVerified: cassVerified.length,
    cassUnverified: cassUnverified.length,
    notEligible: propertyIds.length - allowed.length,
    killSwitchSkipped: killSwitched.length,
    tracefyCreditsRequired: required.total,
    tracefyCreditsAvailable: creditState.available,
    tracefyCreditStatus: creditState.status,
    canLaunchSkipTrace:
      allowed.length > 0 &&
      !hasMixedOrganizations &&
      creditState.status === "sufficient",
    estimatedCassVerificationCostUsd:
      cassVerificationCandidates.length * CASS_COST_PER_LOOKUP_USD,
    cassVerificationPropertyIds: cassVerificationCandidates.map((p) => p.id),
    eligiblePropertyIds: allowed.map((p) => p.id),
    orgId:
      eligibleOrgIds.size === 1
        ? ([...eligibleOrgIds][0] ?? null)
        : (rows[0]?.org_id ?? null),
    hasMixedOrganizations,
    tracefyCreditsRequiredByPart: required.byPart,
  };
}

function mixedOrganizationError(): Result<never> {
  return {
    ok: false,
    error: {
      code: "MIXED_ORGANIZATIONS",
      message: "Select properties from one organization at a time.",
    },
  };
}

function publicPreflight(
  preflight: InternalSkipTracePreflight,
): SkipTracePreflight {
  return {
    requested: preflight.requested,
    eligible: preflight.eligible,
    cassVerified: preflight.cassVerified,
    cassUnverified: preflight.cassUnverified,
    notEligible: preflight.notEligible,
    killSwitchSkipped: preflight.killSwitchSkipped,
    tracefyCreditsRequired: preflight.tracefyCreditsRequired,
    tracefyCreditsAvailable: preflight.tracefyCreditsAvailable,
    tracefyCreditStatus: preflight.tracefyCreditStatus,
    canLaunchSkipTrace: preflight.canLaunchSkipTrace,
    estimatedCassVerificationCostUsd:
      preflight.estimatedCassVerificationCostUsd,
    cassVerificationPropertyIds: preflight.cassVerificationPropertyIds,
  };
}

async function requireTracefyCredits(
  preflight: InternalSkipTracePreflight,
): Promise<Result<null>> {
  if (preflight.eligible === 0) return ok(null);
  if (preflight.tracefyCreditStatus === "sufficient") return ok(null);

  if (preflight.tracefyCreditStatus === "insufficient") {
    return {
      ok: false,
      error: {
        code: "INSUFFICIENT_CREDITS",
        message: `Tracefy has ${preflight.tracefyCreditsAvailable ?? 0} credits; this skip trace needs ${preflight.tracefyCreditsRequired}. Top up before launching.`,
      },
    };
  }

  return {
    ok: false,
    error: {
      code: "TRACEFY_CREDITS_UNAVAILABLE",
      message:
        "Could not confirm Tracefy credits. Retry before launching skip trace.",
    },
  };
}

async function startSkipTraceSubmitWorkflow(
  jobId: string,
  orgId: string,
  surface: string,
): Promise<boolean> {
  try {
    await start(skipTraceSubmitWorkflow, [{ jobId, orgId }]);
    return true;
  } catch (e) {
    reportError(e, {
      tags: { surface },
      extra: { jobId },
    });
    return false;
  }
}

/** Cap removed entirely (Jarrad, 2026-06-11): credit balance is the
 *  operator's intentional throttle — he loads a fixed amount at a time
 *  and tops up deliberately. The runner submits ONE async batch to
 *  Tracefy and exits, so job size is not a function-lifetime concern;
 *  Tracefy refuses spend past the balance. Same policy as the
 *  select-all cap removal (#238). */

/**
 * Server actions for the primary skip-trace UI surfaces:
 *   - bulk from /properties (Surface A)
 *   - single from /leads/[id] (Surface B)
 *   - pending approval from /jobs
 *
 * Request surfaces call `requestSkipTrace` with a list of property ids. The
 * approval gate is enforced server-side: if the caller isn't an admin,
 * the job lands in `pending_approval` and admins get a notification;
 * if the caller IS an admin, the job queues + runs immediately.
 */

export type SkipTraceOutcome = {
  /** Job id for the queued/pending work; null when nothing was eligible. */
  jobId: string | null;
  /**
   * `queued`/`pending_approval` → a job was created. `none_eligible` is a
   * NORMAL, actionable outcome (everything needs CASS or is kill-switched),
   * NOT an error — callers render it as info, never a red failure toast.
   */
  status: "pending_approval" | "queued" | "none_eligible";
  /** Total ids the caller selected. */
  requested: number;
  /** Ids actually sent to the provider. */
  eligible: number;
  /** Skipped because the address isn't CASS-verified. */
  cassSkipped: number;
  /** Skipped because the per-property skip-trace kill switch is on. */
  killSwitchSkipped: number;
};

export type SkipTraceApprovalOutcome = {
  jobId: string;
  status: "queued" | "canceled";
  excluded: number;
};

function uniquePropertyIds(propertyIds: readonly string[]): string[] {
  return [
    ...new Set(
      propertyIds.filter(
        (propertyId): propertyId is string =>
          typeof propertyId === "string" && propertyId.length > 0,
      ),
    ),
  ];
}

export async function preflightSkipTrace(
  propertyIds: string[],
): Promise<Result<SkipTracePreflight>> {
  try {
    if (!Array.isArray(propertyIds) || propertyIds.length === 0) {
      return {
        ok: false,
        error: { code: "VALIDATION", message: "Select at least one property." },
      };
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return {
        ok: false,
        error: { code: "AUTH", message: "Sign in required." },
      };
    }

    const preflight = await buildSkipTracePreflight(
      supabase,
      uniquePropertyIds(propertyIds),
    );
    if (preflight.hasMixedOrganizations) return mixedOrganizationError();
    return ok(publicPreflight(preflight));
  } catch (e) {
    reportError(e, { tags: { surface: "preflight_skip_trace" } });
    return errFromUnknown(e, "PREFLIGHT_SKIP_TRACE_FAILED");
  }
}

export async function requestSkipTrace(
  propertyIds: string[],
): Promise<Result<SkipTraceOutcome>> {
  try {
    if (!Array.isArray(propertyIds) || propertyIds.length === 0) {
      return {
        ok: false,
        error: { code: "VALIDATION", message: "Select at least one property." },
      };
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return {
        ok: false,
        error: { code: "AUTH", message: "Sign in required." },
      };
    }

    const requestedIds = uniquePropertyIds(propertyIds);
    const preflight = await buildSkipTracePreflight(supabase, requestedIds);
    if (preflight.hasMixedOrganizations) return mixedOrganizationError();
    const killSwitchSkipped = preflight.killSwitchSkipped;
    const cassSkipped = preflight.cassVerificationPropertyIds.length;
    if (preflight.eligible === 0) {
      // Nothing eligible — but this is NOT an error. Every selected
      // property either needs CASS verification or has skip-trace
      // disabled, both of which the operator can act on. Returning a
      // success outcome (rather than an error Result) is what stops the
      // UI from painting a normal "verify the addresses first" state as
      // a red failure alert. The caller decides the copy from the counts.
      return ok({
        jobId: null,
        status: "none_eligible",
        requested: requestedIds.length,
        eligible: 0,
        cassSkipped,
        killSwitchSkipped,
      });
    }

    const creditGate = await requireTracefyCredits(preflight);
    if (!creditGate.ok) return creditGate;

    // Use the filtered list from here on — the job only operates on
    // properties that survived BOTH gates.
    const eligibleIds = preflight.eligiblePropertyIds;
    if (!preflight.orgId) {
      return {
        ok: false,
        error: {
          code: "QUERY_FAILED",
          message: "No organization found for selected properties.",
        },
      };
    }
    const orgProbe = { org_id: preflight.orgId };

    const isAdmin = isAdminEmail(user.email);
    const initialStatus: "pending_approval" | "queued" = isAdmin
      ? "queued"
      : "pending_approval";

    // Build a human-readable suffix listing each filter's drop count
    // so the job title and notification copy stay truthful about what
    // actually went to the vendor.
    const skipReasons: string[] = [];
    if (killSwitchSkipped > 0) {
      skipReasons.push(`${killSwitchSkipped} kill-switched`);
    }
    if (cassSkipped > 0) {
      skipReasons.push(
        `${cassSkipped} need${cassSkipped === 1 ? "s" : ""} CASS verification`,
      );
    }
    const skippedSuffix =
      skipReasons.length > 0 ? ` (${skipReasons.join(", ")} skipped)` : "";
    // Auto-split selections that exceed the provider's per-request wire
    // limit into part-jobs. One part = the common case; each part keeps
    // its own Tracefy queue id so per-job finalization is unchanged.
    const parts: string[][] = [];
    for (let i = 0; i < eligibleIds.length; i += PROVIDER_BATCH_MAX) {
      parts.push(eligibleIds.slice(i, i + PROVIDER_BATCH_MAX));
    }

    const batchId = crypto.randomUUID();
    const createdParts: Array<{ jobId: string; propertyIds: string[] }> = [];
    const recordCreatedRequests = async () => {
      const batchCount = createdParts.reduce(
        (count, part) => count + part.propertyIds.length,
        0,
      );
      await recordLeadEvents(
        createdParts.flatMap((part) =>
          part.propertyIds.map((propertyId) => ({
            propertyId,
            eventType: LEAD_EVENT_TYPES.SKIP_TRACE_REQUESTED,
            actorType: "user" as const,
            actorId: user.id,
            payload: {
              job_id: part.jobId,
              batch_id: batchId,
              batch_count: batchCount,
            },
          })),
        ),
      );
    };
    for (let p = 0; p < parts.length; p++) {
      const partIds = parts[p];
      const partLabel =
        parts.length > 1 ? ` (part ${p + 1}/${parts.length})` : "";
      const partSkippedSuffix = p === 0 ? skippedSuffix : "";
      const { data: jobRow, error: insertErr } = await supabase
        .from("jobs")
        .insert({
          type: "skip_trace",
          provider: "tracerfy",
          status: initialStatus,
          org_id: orgProbe.org_id,
          created_by: user.id,
          total_items: partIds.length,
          title: `Skip trace ${partIds.length} propert${partIds.length === 1 ? "y" : "ies"}${partLabel}${partSkippedSuffix}`,
          description: isAdmin
            ? `Admin-initiated; running immediately${partSkippedSuffix}`
            : `Awaiting admin approval (requested by ${user.email ?? "VA"})${partSkippedSuffix}`,
          input_params: {
            property_ids: partIds,
            authorized_max_credits:
              preflight.tracefyCreditsRequiredByPart[p] ?? 0,
            provider_pricing_version: "tracerfy-2026-08",
          },
        })
        .select("id")
        .single();

      if (insertErr || !jobRow) {
        await recordCreatedRequests();
        return {
          ok: false,
          error: {
            code: "JOB_CREATE_FAILED",
            message: insertErr?.message ?? "Failed to create job",
          },
        };
      }
      createdParts.push({ jobId: jobRow.id, propertyIds: partIds });
    }
    await recordCreatedRequests();
    const jobIds = createdParts.map((part) => part.jobId);

    if (isAdmin) {
      // Run immediately via durable Workflow, not a raw after() runner.
      // The workflow step claims each job before hitting Tracerfy, so a
      // cron rescue and this action cannot double-submit the same part.
      for (const jobId of jobIds) {
        await startSkipTraceSubmitWorkflow(
          jobId,
          preflight.orgId,
          "skip_trace_request_workflow_start",
        );
      }
      return ok({
        jobId: jobIds[0],
        status: "queued",
        requested: requestedIds.length,
        eligible: eligibleIds.length,
        cassSkipped,
        killSwitchSkipped,
      });
    }

    // VA path: notify admins once for the whole request.
    try {
      const adminIds = await listAdminUserIds(supabase);
      for (let i = 0; i < jobIds.length; i++) {
        await dispatchSkipTraceRequested(supabase, {
          jobId: jobIds[i],
          requesterEmail: user.email ?? null,
          propertyCount: parts[i]?.length ?? 0,
          adminUserIds: adminIds,
        });
      }
    } catch (e) {
      reportError(e, {
        tags: { surface: "skip_trace_request_notify" },
        extra: { jobId: jobIds[0] },
      });
    }
    return ok({
      jobId: jobIds[0],
      status: "pending_approval",
      requested: requestedIds.length,
      eligible: eligibleIds.length,
      cassSkipped,
      killSwitchSkipped,
    });
  } catch (e) {
    reportError(e, { tags: { surface: "request_skip_trace" } });
    return errFromUnknown(e, "REQUEST_SKIP_TRACE_FAILED");
  }
}

/**
 * Admin-only: approve a pending skip-trace job. Pre-flight checks the
 * provider's credit balance to refuse if the account would go negative.
 */
export async function approveSkipTraceJob(
  jobId: string,
): Promise<Result<SkipTraceApprovalOutcome>> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!isAdminEmail(user?.email)) {
      return {
        ok: false,
        error: {
          code: "FORBIDDEN",
          message: "Only admins can approve skip-trace jobs.",
        },
      };
    }

    const { data: job, error: jobError } = await supabase
      .from("jobs")
      .select(
        "id, org_id, status, total_items, title, description, input_params, result_summary",
      )
      .eq("id", jobId)
      .eq("type", "skip_trace")
      .maybeSingle();
    if (jobError) {
      return {
        ok: false,
        error: { code: "QUERY_FAILED", message: jobError.message },
      };
    }
    if (!job) {
      return {
        ok: false,
        error: { code: "NOT_FOUND", message: "Job not found." },
      };
    }
    if (job.status !== "pending_approval") {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: `Job is in '${job.status}', not 'pending_approval'.`,
        },
      };
    }

    const rawPropertyIds = (
      job.input_params as { property_ids?: string[] } | null
    )?.property_ids;
    if (!Array.isArray(rawPropertyIds) || rawPropertyIds.length === 0) {
      return {
        ok: false,
        error: { code: "VALIDATION", message: "Job has no property ids." },
      };
    }
    const propertyIds = uniquePropertyIds(rawPropertyIds);

    const eligibility = await resolveSkipTraceEligibility(supabase, {
      orgId: job.org_id,
      propertyIds,
    });
    const audit = buildSkipTraceEligibilityAudit(
      eligibility,
      propertyIds.length,
    );
    const inputParams =
      job.input_params &&
      typeof job.input_params === "object" &&
      !Array.isArray(job.input_params)
        ? (job.input_params as Record<string, Json | undefined>)
        : {};
    const resultSummary =
      job.result_summary &&
      typeof job.result_summary === "object" &&
      !Array.isArray(job.result_summary)
        ? (job.result_summary as Record<string, Json | undefined>)
        : {};
    const nextInputParams = {
      ...inputParams,
      property_ids: eligibility.eligibleIds,
      eligibility_exclusions: audit,
    } as unknown as Json;
    const nextResultSummary = {
      ...resultSummary,
      eligibility_exclusions: audit,
    } as unknown as Json;

    if (eligibility.eligibleIds.length === 0) {
      const { data: canceledJob, error: cancelError } = await supabase
        .from("jobs")
        .update({
          status: "canceled",
          total_items: 0,
          title: skipTraceAudienceTitle(job.title, 0, audit.total),
          input_params: nextInputParams,
          result_summary: nextResultSummary,
          completed_at: new Date().toISOString(),
          description: skipTraceAudienceDescription(
            job.description,
            0,
            audit.total,
          ),
        })
        .eq("id", jobId)
        .eq("status", "pending_approval")
        .is("provider_run_id", null)
        .select("id")
        .maybeSingle();
      if (cancelError) {
        return {
          ok: false,
          error: {
            code: "APPROVE_SKIP_TRACE_FAILED",
            message: cancelError.message,
          },
        };
      }
      if (!canceledJob) {
        return {
          ok: false,
          error: {
            code: "APPROVAL_ALREADY_CLAIMED",
            message:
              "This skip-trace job was already approved or is no longer pending.",
          },
        };
      }
      return ok({ jobId, status: "canceled", excluded: audit.total });
    }

    const preflight = await buildSkipTracePreflight(
      supabase,
      eligibility.eligibleIds,
    );
    const creditGate = await requireTracefyCredits(preflight);
    if (!creditGate.ok) return creditGate;
    const approvedInputParams = {
      ...(nextInputParams as Record<string, Json | undefined>),
      authorized_max_credits: preflight.tracefyCreditsRequired,
      provider_pricing_version: "tracerfy-2026-08",
    } as unknown as Json;

    const { data: claimedJob, error: claimErr } = await supabase
      .from("jobs")
      .update({
        status: "queued",
        total_items: eligibility.eligibleIds.length,
        title: skipTraceAudienceTitle(
          job.title,
          eligibility.eligibleIds.length,
          audit.total,
        ),
        input_params: approvedInputParams,
        result_summary: nextResultSummary,
        description: skipTraceAudienceDescription(
          `Approved by ${user?.email ?? "admin"}. ${job.description ?? ""}`.trim(),
          eligibility.eligibleIds.length,
          audit.total,
        ),
      })
      .eq("id", jobId)
      .eq("status", "pending_approval")
      .is("provider_run_id", null)
      .select("id")
      .maybeSingle();
    if (claimErr) {
      return {
        ok: false,
        error: {
          code: "APPROVE_SKIP_TRACE_FAILED",
          message: claimErr.message,
        },
      };
    }
    if (!claimedJob) {
      return {
        ok: false,
        error: {
          code: "APPROVAL_ALREADY_CLAIMED",
          message:
            "This skip-trace job was already approved or is no longer pending.",
        },
      };
    }

    await startSkipTraceSubmitWorkflow(
      jobId,
      job.org_id,
      "approve_skip_trace_workflow_start",
    );

    return ok({ jobId, status: "queued", excluded: audit.total });
  } catch (e) {
    reportError(e, { tags: { surface: "approve_skip_trace_job" } });
    return errFromUnknown(e, "APPROVE_SKIP_TRACE_FAILED");
  }
}

/**
 * Admin-only: deny a pending skip-trace job. Stashes the optional
 * reason in error_message and notifies the requester via job-completed
 * dispatch (reuses the existing notification pipeline).
 */
export async function denySkipTraceJob(
  jobId: string,
  reason?: string,
): Promise<Result<{ jobId: string }>> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!isAdminEmail(user?.email)) {
      return {
        ok: false,
        error: {
          code: "FORBIDDEN",
          message: "Only admins can deny skip-trace jobs.",
        },
      };
    }

    const { data: job } = await supabase
      .from("jobs")
      .select("status")
      .eq("id", jobId)
      .maybeSingle();
    if (!job) {
      return {
        ok: false,
        error: { code: "NOT_FOUND", message: "Job not found." },
      };
    }
    if (job.status !== "pending_approval") {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: `Job is in '${job.status}', not 'pending_approval'.`,
        },
      };
    }

    await supabase
      .from("jobs")
      .update({
        status: "denied",
        completed_at: new Date().toISOString(),
        error_message: reason ?? `Denied by ${user?.email ?? "admin"}`,
      })
      .eq("id", jobId);

    // Reuse job-completed dispatch to notify the requester.
    try {
      await dispatchJobCompleted(supabase, { jobId });
    } catch (e) {
      reportError(e, { tags: { surface: "skip_trace_deny_notify" } });
    }
    return ok({ jobId });
  } catch (e) {
    reportError(e, { tags: { surface: "deny_skip_trace_job" } });
    return errFromUnknown(e, "DENY_SKIP_TRACE_FAILED");
  }
}
