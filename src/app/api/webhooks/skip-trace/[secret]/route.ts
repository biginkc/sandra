import { createHash, timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import { finalizeSkipTraceFromBatch } from "@/lib/skip-trace/skip-trace-job";
import type {
  SkipTraceEmail,
  SkipTracePerson,
  SkipTracePhone,
  SkipTraceResult,
} from "@/lib/skip-trace/types";
import type { Database } from "@/lib/supabase/types";

/**
 * Skip-trace provider webhook receiver.
 *
 * URL: `POST /api/webhooks/skip-trace/<consumer-secret>`
 *
 * The path was `/api/webhooks/tracerfy/...` until migration 033 — the
 * vendor-specific name baked in the wrong assumption that Tracerfy is
 * the only skip-trace provider. The new path is provider-agnostic; the
 * payload-shape parsing below is still Tracerfy-specific (queue_id,
 * persons.phones, etc.), but a future provider with a different shape
 * gets its own per-vendor parsing branch behind the same auth surface.
 *
 * **Auth — DB-backed per-consumer secret.** SHA-256 the URL secret,
 * look up `webhook_consumers` where `consumer_type='provider'` AND
 * `enabled=true` AND `revoked_at IS NULL`. The `consumer_type` filter
 * means a lead-intake secret (Enzo's) cannot authenticate here, even
 * if it leaks. Mirrors the same auth pattern as the lead-intake
 * webhook at `/api/webhooks/leads/[secret]`.
 *
 * The legacy `TRACERFY_WEBHOOK_SECRET` env var is no longer read by
 * this route (removed in migration 033's PR). Once Tracerfy's webhook
 * config is updated to the new URL with a freshly-rotated secret, the
 * env var can be removed from Vercel — see PR description for the
 * cutover steps.
 *
 * Payload shape: same as `GET /v1/api/queue/:id` — an array of
 * property records each with `external_id` (we set it to our property
 * id when we submitted the batch), `hit`, `persons`, `credits_deducted`.
 *
 * We also defensively validate that the payload's queue id matches a
 * job we created with that `provider_run_id`. Reject if no match — a
 * cheap defense against forged payloads even if the secret leaks.
 */

function hashSecret(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

type TracerfyWebhookRow = {
  external_id?: string;
  queue_id?: number | string;
  hit?: boolean;
  persons_count?: number;
  credits_deducted?: number;
  /** Tracerfy echoes the input address fields per row — we use them
   *  to match results back to our property since `external_id` is
   *  not reliably round-tripped. */
  address?: string;
  city?: string;
  state?: string;
  persons?: Array<{
    first_name?: string;
    last_name?: string;
    property_owner?: boolean;
    phones?: Array<{
      number: string;
      type?: string;
      dnc?: boolean;
      carrier?: string;
      rank: number;
    }>;
    emails?: Array<{ email: string; rank: number }>;
  }>;
};

type TracerfyWebhookPayload =
  | TracerfyWebhookRow[]
  | { queue_id: number | string; rows: TracerfyWebhookRow[] };

export async function POST(
  request: Request,
  { params }: { params: Promise<{ secret: string }> },
) {
  const { secret } = await params;
  if (!secret || typeof secret !== "string" || secret.length < 16) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const secretHash = hashSecret(secret);

  // Service-role client — webhook has no user session.
  const supabase = createSupabaseClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  // Per-consumer auth: hash the URL secret, look up the row.
  // `consumer_type='provider'` filter blocks lead-intake secrets from
  // authenticating here even if they leak — defense in depth on top of
  // the per-row enabled/revoked flags.
  const { data: consumer, error: lookupErr } = await supabase
    .from("webhook_consumers")
    .select("id, name, enabled, revoked_at")
    .eq("secret_hash", secretHash)
    .eq("consumer_type", "provider")
    .maybeSingle();
  if (lookupErr) {
    reportError(lookupErr, {
      tags: { surface: "skip_trace_webhook_consumer_lookup" },
    });
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
  if (!consumer || !consumer.enabled || consumer.revoked_at) {
    // Fail-closed and don't leak which condition tripped — same 403
    // for unknown / wrong-type / disabled / revoked.
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Defense-in-depth constant-time check on the hash itself. The
  // unique-indexed secret_hash column makes this redundant in practice
  // (no row collision is possible), but matches the lead-webhook
  // pattern so the two routes look alike.
  const stored = Buffer.from(consumer.id ? secretHash : "");
  const submitted = Buffer.from(secretHash);
  if (
    stored.length !== submitted.length ||
    !timingSafeEqual(stored, submitted)
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: TracerfyWebhookPayload;
  try {
    body = (await request.json()) as TracerfyWebhookPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Normalize the two possible shapes into { queueId, rows }.
  let queueId: string | null = null;
  let rows: TracerfyWebhookRow[] = [];
  if (Array.isArray(body)) {
    rows = body;
    queueId = String(body[0]?.queue_id ?? "");
  } else if (body && typeof body === "object" && "rows" in body) {
    rows = body.rows ?? [];
    queueId = String(body.queue_id ?? "");
  }

  if (!queueId) {
    return NextResponse.json(
      { error: "Could not extract queue_id from payload" },
      { status: 400 },
    );
  }

  // Defense in depth: only accept the payload if we have a job that
  // submitted this exact queue id.
  const { data: job, error: jobErr } = await supabase
    .from("jobs")
    .select("id, status")
    .eq("provider_run_id", queueId)
    .eq("type", "skip_trace")
    .maybeSingle();
  if (jobErr || !job) {
    reportError(new Error("Tracerfy webhook for unknown queue_id"), {
      tags: { surface: "skip_trace_webhook" },
      extra: { queueId },
    });
    // Return 200 so Tracerfy doesn't retry — the work isn't ours.
    return NextResponse.json({ ignored: "unknown queue_id" });
  }

  if (job.status !== "running") {
    // Already finalized (cron poll beat us, or duplicate webhook).
    return NextResponse.json({ ignored: `job ${job.id} is ${job.status}` });
  }

  // Map rows → SkipTraceResult shape. Carry through the input address
  // fields so finalize can match each row back to our property by
  // address (Tracerfy dedupes batches and doesn't reliably round-trip
  // external_id).
  const results: SkipTraceResult[] = rows.map((row) => ({
    propertyId: row.external_id ?? "",
    matchedAddress: {
      address: row.address ?? "",
      city: row.city ?? "",
      state: row.state ?? "",
    },
    hit: !!row.hit,
    persons: (row.persons ?? []).map(mapPerson),
    creditsDeducted: row.credits_deducted ?? 0,
    raw: row,
  }));

  try {
    await finalizeSkipTraceFromBatch(supabase, {
      jobId: job.id,
      results,
    });
  } catch (e) {
    reportError(e, {
      tags: { surface: "skip_trace_webhook_finalize" },
      extra: { jobId: job.id, queueId },
    });
    // 500 → provider will retry. Acceptable.
    return NextResponse.json({ error: "Finalize failed" }, { status: 500 });
  }

  // Stamp last_used_at for the audit trail. Non-fatal on failure —
  // the finalize already succeeded.
  try {
    await supabase
      .from("webhook_consumers")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", consumer.id);
  } catch (e) {
    reportError(e, {
      tags: { surface: "skip_trace_webhook_last_used_stamp" },
      extra: { consumer: consumer.name },
    });
  }

  return NextResponse.json({ ok: true, jobId: job.id, rows: results.length });
}

function mapPerson(p: {
  first_name?: string;
  last_name?: string;
  property_owner?: boolean;
  phones?: Array<{
    number: string;
    type?: string;
    dnc?: boolean;
    carrier?: string;
    rank: number;
  }>;
  emails?: Array<{ email: string; rank: number }>;
}): SkipTracePerson {
  return {
    firstName: p.first_name ?? null,
    lastName: p.last_name ?? null,
    isOwner: p.property_owner === true,
    phones: (p.phones ?? []).map(
      (ph): SkipTracePhone => ({
        number: ph.number,
        type:
          ph.type === "Mobile"
            ? "Mobile"
            : ph.type === "Landline"
              ? "Landline"
              : "Unknown",
        dnc: !!ph.dnc,
        rank: ph.rank,
        carrier: ph.carrier ?? null,
      }),
    ),
    emails: (p.emails ?? []).map((e): SkipTraceEmail => ({
      email: e.email,
      rank: e.rank,
    })),
  };
}
