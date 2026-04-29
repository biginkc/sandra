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
 * Tracerfy batch webhook receiver.
 *
 * Tracerfy doesn't sign webhooks per their published docs, so we
 * authenticate via a per-deployment secret in the URL path:
 *
 *   /api/webhooks/tracerfy/<TRACERFY_WEBHOOK_SECRET>
 *
 * Configure the same URL in your Tracerfy account settings.
 *
 * Payload shape: same as `GET /v1/api/queue/:id` — an array of property
 * records each with `external_id` (we set it to our property id when we
 * submitted the batch), `hit`, `persons`, `credits_deducted`.
 *
 * We also defensively validate that the payload's queue id matches a
 * job we created with that `provider_run_id`. Reject if no match — a
 * cheap defense against forged payloads even if the secret leaks.
 */

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
  const expectedSecret = process.env.TRACERFY_WEBHOOK_SECRET;
  if (!expectedSecret) {
    // Feature off: we don't know what to authenticate against.
    return NextResponse.json({ error: "Webhook disabled" }, { status: 503 });
  }

  const { secret } = await params;
  if (secret !== expectedSecret) {
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

  // Service-role client — webhook has no user session.
  const supabase = createSupabaseClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

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
      tags: { surface: "tracerfy_webhook" },
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
      tags: { surface: "tracerfy_webhook_finalize" },
      extra: { jobId: job.id, queueId },
    });
    // 500 → Tracerfy will retry. Acceptable.
    return NextResponse.json({ error: "Finalize failed" }, { status: 500 });
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
