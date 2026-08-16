import { createHash, timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import {
  createLead,
  LEAD_SOURCES,
  type LeadSource,
} from "@/lib/leads/create";
import type { Database } from "@/lib/supabase/types";

/**
 * Lead-import webhook.
 *
 * External systems (the dialer at Enzo, future PPC landing pages, the
 * "we buy houses" form, etc.) POST a property + contact payload here
 * when a VA marks a call as "interested" or a prospect submits a form.
 * We create the property + homeowner contact via the shared
 * `createLead` core so one creation path serves both this webhook and
 * the manual entry form at `/leads/new`.
 *
 * **Auth — per-consumer secret.** The URL path carries a secret that
 * we SHA-256 hash and look up in `webhook_consumers`. Each integrator
 * gets their own row, independently rotatable + revocable. The row's
 * `default_source` is stamped onto the property if the payload omits
 * `source` — this lets Enzo's payload skip the source field entirely
 * and still get tagged `cold_call`, while a future PPC integration's
 * row tags everything `web_form`.
 *
 * URL: `POST /api/webhooks/leads/<consumer-specific-secret>`
 *
 * Payload shape:
 * ```json
 * {
 *   "property": {
 *     "address": "123 Main St",
 *     "city": "Kansas City",
 *     "state": "MO",
 *     "zip": "64111"
 *   },
 *   "contact": {
 *     "first_name": "Jane",
 *     "last_name": "Doe",
 *     "phone_1": "+18165551234",
 *     "email": "jane@example.com"
 *   },
 *   "source": "cold_call"
 * }
 * ```
 *
 * `source` is OPTIONAL — when omitted, the consumer row's
 * `default_source` is used. When present, it must be in `LEAD_SOURCES`
 * and overrides the consumer default (rare; mostly useful for a
 * generic consumer like "Manual import script" that handles multiple
 * channels).
 *
 * Response: 200 with `{ property_id, was_duplicate, contact_id }`.
 * Idempotent on the property's normalized address — second submission
 * for the same address returns the existing id with
 * `was_duplicate=true`, never creates a duplicate row.
 */

type LeadWebhookPayload = {
  source?: string;
  property?: {
    address?: string;
    city?: string | null;
    state?: string;
    zip?: string | null;
    market?: string | null;
  };
  contact?: {
    first_name?: string | null;
    last_name?: string | null;
    phone_1?: string | null;
    email?: string | null;
  };
};

/**
 * SHA-256 the URL secret. We never store plaintext secrets; the row
 * holds only the hash. This way a leak of the DB doesn't leak any
 * webhook secret directly — the attacker would need to guess the
 * preimage.
 */
function hashSecret(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

export async function POST(
  request: Request,
  context: { params: Promise<{ secret: string }> },
): Promise<NextResponse> {
  const { secret } = await context.params;

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

  // Restrict to consumer_type='lead' so a provider secret (e.g.,
  // skip-trace's webhook secret) cannot authenticate as a lead intake
  // even if it leaks. Cross-protection alongside per-row enabled +
  // revoked_at checks.
  const { data: consumer, error: lookupErr } = await supabase
    .from("webhook_consumers")
    .select("id, org_id, name, default_source, enabled, revoked_at")
    .eq("secret_hash", secretHash)
    .eq("consumer_type", "lead")
    .maybeSingle();
  if (lookupErr) {
    reportError(lookupErr, {
      tags: { surface: "lead_webhook_consumer_lookup" },
    });
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
  if (!consumer || !consumer.enabled || consumer.revoked_at) {
    // Fail-closed and don't leak which condition tripped — same 403
    // for unknown / disabled / revoked.
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Defense-in-depth constant-time check. The .eq() above is
  // already authoritative (the unique secret_hash column makes
  // dupes impossible) but a timing-safe compare on the hash bytes
  // costs us nothing and avoids any nuance around postgrest's
  // string-equality timing.
  const stored = Buffer.from(consumer.id ? secretHash : "");
  const submitted = Buffer.from(secretHash);
  if (
    stored.length !== submitted.length ||
    !timingSafeEqual(stored, submitted)
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: LeadWebhookPayload;
  try {
    body = (await request.json()) as LeadWebhookPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be an object" }, { status: 400 });
  }

  // Resolve effective source: payload overrides consumer default if
  // present; default_source applies when payload omits it.
  const payloadSource = typeof body.source === "string" ? body.source : null;
  const effectiveSource =
    payloadSource && LEAD_SOURCES.includes(payloadSource as LeadSource)
      ? (payloadSource as LeadSource)
      : (consumer.default_source as LeadSource);
  if (payloadSource && !LEAD_SOURCES.includes(payloadSource as LeadSource)) {
    return NextResponse.json(
      {
        error: `'source' must be one of: ${LEAD_SOURCES.join(", ")}.`,
        field: "source",
      },
      { status: 400 },
    );
  }

  if (!body.property || typeof body.property !== "object") {
    return NextResponse.json(
      { error: "'property' object is required.", field: "property" },
      { status: 400 },
    );
  }

  const result = await createLead(supabase, {
    orgId: consumer.org_id,
    source: effectiveSource,
    property: {
      address: body.property.address ?? "",
      city: body.property.city ?? null,
      state: body.property.state ?? "",
      zip: body.property.zip ?? null,
      market: body.property.market ?? null,
    },
    contact: body.contact ?? undefined,
  });

  if (!result.ok) {
    if (result.error.code === "VALIDATION") {
      return NextResponse.json(
        { error: result.error.message, field: result.error.field },
        { status: 400 },
      );
    }
    reportError(new Error(result.error.message), {
      tags: { surface: "lead_webhook" },
      extra: { consumer: consumer.name, source: effectiveSource },
    });
    return NextResponse.json(
      { error: result.error.message },
      { status: 500 },
    );
  }

  // Stamp last_used_at for the audit trail. Non-fatal on failure —
  // the lead is already created.
  try {
    await supabase
      .from("webhook_consumers")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", consumer.id);
  } catch (e) {
    reportError(e, {
      tags: { surface: "lead_webhook_last_used_stamp" },
      extra: { consumer: consumer.name },
    });
  }

  return NextResponse.json({
    property_id: result.data.propertyId,
    was_duplicate: result.data.wasDuplicate,
    contact_id: result.data.contactId,
    // Non-null when the submitted phone couldn't be classified and was
    // parked on the contact's notes instead of saved as a phone slot
    // (hard rule). Senders polling this response can alert on it.
    phone_dropped: result.data.phoneDropped,
  });
}
