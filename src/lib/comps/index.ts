import "server-only";

import { reportError } from "@/lib/errors/report";
import { getMyLeadsFlag } from "@/lib/my-leads/flags";
import { schemaReady } from "@/lib/my-leads/schema-ready";
import { createAdminClient } from "@/lib/supabase/admin";

import { getCompProvider } from "./config";
import { normalizeProviderResult } from "./normalize";
import {
  CompProviderError,
  DEFAULT_COMP_SETTINGS,
  LEAD_COMPS_MEMBER_COLUMNS,
  type CompLeadResult,
  type CompProvider,
  type CompSettings,
  type CompSubject,
  type CompTrigger,
} from "./types";

export { computeAnchors } from "./anchors";
export { getCompProvider } from "./config";
export { normalizeProviderResult } from "./normalize";
export * from "./types";

/** Minimal structural client: these tables are not in the generated types until regeneration. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CompsClient = any;

export type CompDeps = {
  admin?: CompsClient;
  provider?: CompProvider | null;
  flagEnabled?: (orgId: string) => Promise<boolean>;
  schemaReady?: () => Promise<boolean>;
  /** Inline claim deadline (ms). */
  inlineDeadlineMs?: number;
  providerTimeoutMs?: number;
  /** Drain only: claimed rows for an org this returns false for are finished as `cancelled` (flag off). */
  orgAllowed?: (orgId: string) => Promise<boolean>;
};

export const PROVIDER_TIMEOUT_MS = 20_000;
export const INLINE_DEADLINE_MS = 25_000;

type FetchRequest = {
  id: string;
  org_id: string;
  property_id: string;
  trigger: CompTrigger;
  reserved_calls: number;
};

function resolveDeps(deps: CompDeps | undefined) {
  return {
    admin: deps?.admin ?? (createAdminClient() as CompsClient),
    provider: deps && "provider" in deps ? (deps.provider ?? null) : getCompProvider(),
    orgAllowed: deps?.orgAllowed,
    flagEnabled: deps?.flagEnabled ?? ((orgId: string) => getMyLeadsFlag(orgId, "comp_queue")),
    schemaReady: deps?.schemaReady ?? (() => schemaReady("lead_comps")),
    inlineDeadlineMs: deps?.inlineDeadlineMs ?? INLINE_DEADLINE_MS,
    providerTimeoutMs: deps?.providerTimeoutMs ?? PROVIDER_TIMEOUT_MS,
  };
}

async function loadSubject(admin: CompsClient, propertyId: string): Promise<
  | { ok: true; subject: CompSubject; isTraining: boolean; deleted: boolean }
  | { ok: false }
> {
  const { data, error } = await admin
    .from("properties")
    .select("id, org_id, address, city, state, zip, attom_id, fips_code, apn, sqft, beds, baths, year_built, lat, lon, is_training, deleted_at")
    .eq("id", propertyId)
    .maybeSingle();
  if (error || !data) return { ok: false };
  return {
    ok: true,
    isTraining: data.is_training === true,
    deleted: data.deleted_at != null,
    subject: {
      propertyId: data.id,
      orgId: data.org_id,
      address: data.address ?? "",
      city: data.city ?? null,
      state: data.state ?? "",
      zip: data.zip ?? null,
      attomId: data.attom_id ?? null,
      fips: data.fips_code ?? null,
      apn: data.apn ?? null,
      sqft: data.sqft ?? null,
      beds: data.beds ?? null,
      baths: data.baths ?? null,
      yearBuilt: data.year_built ?? null,
      lat: data.lat ?? null,
      lon: data.lon ?? null,
    },
  };
}

async function newestCompId(admin: CompsClient, orgId: string, propertyId: string): Promise<string | null> {
  const { data } = await admin
    .from("lead_comps")
    .select("id")
    .eq("org_id", orgId)
    .eq("property_id", propertyId)
    .order("fetched_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.id ?? null;
}

async function loadSettings(admin: CompsClient, orgId: string): Promise<CompSettings> {
  const { data } = await admin
    .from("org_comp_settings")
    .select("verify_min_comps, verify_max_fsd_pct")
    .eq("org_id", orgId)
    .maybeSingle();
  if (!data) return DEFAULT_COMP_SETTINGS;
  return {
    verify_min_comps: Number(data.verify_min_comps ?? DEFAULT_COMP_SETTINGS.verify_min_comps),
    verify_max_fsd_pct: Number(data.verify_max_fsd_pct ?? DEFAULT_COMP_SETTINGS.verify_max_fsd_pct),
  };
}

/**
 * Comp one lead (§3.2). Inert unless the org's `comp_queue` flag is on and the `lead_comps`
 * schema is ready (`disabled`). The SQL cap ledger is the only spend control: with
 * `monthly_call_cap = 0` the enqueue RPC answers `disabled` and no provider call is made.
 */
export async function compLead(
  propertyId: string,
  opts?: { trigger?: CompTrigger; requestedBy?: string | null; inline?: boolean; deps?: CompDeps },
): Promise<CompLeadResult> {
  const d = resolveDeps(opts?.deps);
  const trigger = opts?.trigger ?? "manual";
  const loaded = await loadSubject(d.admin, propertyId);
  if (!loaded.ok) return { status: "unavailable", reason: "not_found" };
  if (loaded.isTraining) return { status: "unavailable", reason: "training_lead" };
  if (loaded.deleted) return { status: "unavailable", reason: "not_found" };
  if (!loaded.subject.address.trim() || !loaded.subject.state.trim()) return { status: "unavailable", reason: "missing_address" };
  const orgId = loaded.subject.orgId;
  if (!(await d.flagEnabled(orgId)) || !(await d.schemaReady())) return { status: "disabled" };

  const { data, error } = await d.admin.rpc("fn_enqueue_comp_fetch", {
    p_org_id: orgId,
    p_property_id: propertyId,
    p_trigger: trigger,
    p_requested_by: opts?.requestedBy ?? null,
  });
  if (error || !data || typeof data !== "object") return { status: "error", code: "ENQUEUE_FAILED" };
  const outcome = data as { status?: string; requestId?: string; noMatch?: boolean };
  switch (outcome.status) {
    case "fresh": {
      // A recent no_match inside the window: do not re-queue, and there is no row to show.
      if (outcome.noMatch) return { status: "no_match" };
      const compId = await newestCompId(d.admin, orgId, propertyId);
      return compId ? { status: "ready", compId, cached: true } : { status: "error", code: "FRESH_ROW_MISSING" };
    }
    case "in_flight": {
      const { data: open } = await d.admin
        .from("comp_fetch_requests")
        .select("id")
        .eq("org_id", orgId)
        .eq("property_id", propertyId)
        .in("status", ["queued", "running"])
        .limit(1)
        .maybeSingle();
      return { status: "pending", requestId: open?.id ?? "" };
    }
    case "backoff":
      // A recent error (bad key, rate limit) is inside its backoff window: nothing was queued.
      return { status: "error", code: "BACKOFF" };
    case "disabled":
      return { status: "disabled" };
    case "capped":
      return { status: "capped" };
    case "unavailable":
      return { status: "unavailable", reason: "not_found" };
    case "queued": {
      const requestId = typeof outcome.requestId === "string" ? outcome.requestId : "";
      if (!opts?.inline) return { status: "pending", requestId };
      const result = await drainCompQueue(1, { ...opts.deps, admin: d.admin, provider: d.provider }, { onlyRequestId: requestId, deadlineMs: d.inlineDeadlineMs });
      if (result.outcomes[0]?.status === "ok" && result.outcomes[0].compId) return { status: "ready", compId: result.outcomes[0].compId, cached: false };
      if (result.outcomes[0]?.status === "no_match") return { status: "no_match" };
      if (result.outcomes[0]?.status === "capped") return { status: "capped" };
      return { status: "pending", requestId };
    }
    default:
      return { status: "error", code: "UNEXPECTED_ENQUEUE_STATUS" };
  }
}

export type DrainOutcome = { requestId: string; status: "ok" | "no_match" | "error" | "capped" | "cancelled"; compId?: string; code?: string };

/**
 * Claims up to `limit` queued requests (manual first; the SQL function marks over-cap requests
 * `capped` and returns only reserved ones), runs the provider with a timeout, stores the row and
 * trues up the ledger. `AUTH` is reported once per drain; `RATE_LIMIT` leaves the request in
 * `error` with the retry hint in `error_code`.
 */
export async function drainCompQueue(
  limit: number,
  deps?: CompDeps,
  inline?: { onlyRequestId: string; deadlineMs: number },
): Promise<{ claimed: number; ok: number; failed: number; outcomes: DrainOutcome[] }> {
  const d = resolveDeps(deps);
  const outcomes: DrainOutcome[] = [];
  const provider = d.provider;
  // Inline ("Comp this lead") claims only its own row via p_request_id, so it can never claim (and
  // strand in `running`) another org's queued row.
  const claimArgs: { p_limit: number; p_request_id?: string } = { p_limit: Math.max(1, Math.min(limit, 100)) };
  if (inline) claimArgs.p_request_id = inline.onlyRequestId;
  const { data: claimedRows, error: claimError } = await d.admin.rpc("fn_claim_comp_fetches", claimArgs);
  if (claimError || !Array.isArray(claimedRows)) return { claimed: 0, ok: 0, failed: 0, outcomes };
  const requests = claimedRows as FetchRequest[];
  let authReported = false;
  const started = Date.now();
  let ok = 0;
  let failed = 0;

  const orgVerdicts = new Map<string, boolean>();
  for (const req of requests) {
    if (d.orgAllowed) {
      let allowed = orgVerdicts.get(req.org_id);
      if (allowed === undefined) {
        allowed = await d.orgAllowed(req.org_id).catch(() => false);
        orgVerdicts.set(req.org_id, allowed);
      }
      if (!allowed) {
        // Flag off for this org: release the reservation (billed 0) without calling the provider.
        await finish(d.admin, req.id, "cancelled", 0, null, null);
        outcomes.push({ requestId: req.id, status: "cancelled" });
        continue;
      }
    }
    if (!provider) {
      await finish(d.admin, req.id, "error", 0, "NO_PROVIDER", null);
      outcomes.push({ requestId: req.id, status: "error", code: "NO_PROVIDER" });
      failed += 1;
      continue;
    }
    const loaded = await loadSubject(d.admin, req.property_id);
    if (!loaded.ok || loaded.isTraining || loaded.deleted) {
      await finish(d.admin, req.id, "error", 0, "SUBJECT_UNAVAILABLE", null);
      outcomes.push({ requestId: req.id, status: "error", code: "SUBJECT_UNAVAILABLE" });
      failed += 1;
      continue;
    }
    const controller = new AbortController();
    const budget = inline ? Math.max(1, inline.deadlineMs - (Date.now() - started)) : d.providerTimeoutMs;
    const timer = setTimeout(() => controller.abort(), Math.min(budget, d.providerTimeoutMs));
    try {
      const result = await provider.fetch(loaded.subject, controller.signal);
      const settings = await loadSettings(d.admin, req.org_id);
      const row = normalizeProviderResult(result, provider.name, settings);
      const { data: inserted, error: insertError } = await d.admin
        .from("lead_comps")
        .insert({ ...row, org_id: req.org_id, property_id: req.property_id, request_id: req.id })
        .select("id")
        .single();
      if (insertError || !inserted?.id) {
        await finish(d.admin, req.id, "error", result.billedCalls, "STORE_FAILED", null);
        outcomes.push({ requestId: req.id, status: "error", code: "STORE_FAILED" });
        failed += 1;
        continue;
      }
      await finish(d.admin, req.id, "ok", result.billedCalls, null, inserted.id);
      outcomes.push({ requestId: req.id, status: "ok", compId: inserted.id });
      ok += 1;
    } catch (error) {
      const code = error instanceof CompProviderError ? error.code : "UNKNOWN";
      const billed = error instanceof CompProviderError ? error.billedCalls : 0;
      if (code === "NOT_FOUND") {
        await finish(d.admin, req.id, "no_match", billed, null, null);
        outcomes.push({ requestId: req.id, status: "no_match" });
        failed += 1;
        continue;
      }
      const errorCode = code === "RATE_LIMIT" && error instanceof CompProviderError && error.retryAfterSec !== undefined
        ? `RATE_LIMIT_RETRY_${Math.min(Math.round(error.retryAfterSec), 86_400)}`
        : code;
      await finish(d.admin, req.id, "error", billed, errorCode, null);
      outcomes.push({ requestId: req.id, status: "error", code: errorCode });
      failed += 1;
      if (code === "AUTH" && !authReported) {
        authReported = true;
        reportError(error, { errorClass: "provider", tags: { surface: "comps", provider: provider.name, operation: "comp_fetch_auth" } });
      } else if (code === "UNKNOWN") {
        reportError(error, { tags: { surface: "comps", operation: "comp_fetch" } });
      }
    } finally {
      clearTimeout(timer);
    }
  }
  return { claimed: requests.length, ok, failed, outcomes };
}

async function finish(admin: CompsClient, requestId: string, status: string, billed: number, errorCode: string | null, compId: string | null) {
  try {
    await admin.rpc("fn_finish_comp_fetch", {
      p_request_id: requestId,
      p_status: status,
      p_billed_calls: billed,
      p_error_code: errorCode,
      p_lead_comp_id: compId,
    });
  } catch (error) {
    reportError(error, { tags: { surface: "comps", operation: "comp_finish" } });
  }
}

/** Latest stored comp for a lead through the caller's RLS client (member columns only). */
export async function loadLatestLeadComp(client: CompsClient, orgId: string, propertyId: string) {
  const { data, error } = await client
    .from("lead_comps")
    .select(LEAD_COMPS_MEMBER_COLUMNS)
    .eq("org_id", orgId)
    .eq("property_id", propertyId)
    .order("fetched_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return data ?? null;
}
