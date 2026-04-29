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
 * External systems (the dialer at Enzo, future PPC landing pages,
 * etc.) POST a property + contact payload here when a VA marks a
 * call as "interested" or a prospect submits a form. We create the
 * property + homeowner contact via the shared `createLead` core so
 * one creation path serves both this webhook and the manual entry
 * form at `/leads/new`.
 *
 * Auth: per-deployment secret in URL path, mirrors the Tracerfy
 * webhook pattern. Configure `LEAD_WEBHOOK_SECRET` in Vercel env
 * and give the same value to the integrating system. Rotate by
 * replacing the env var (the new admin/keys page surfaces this in a
 * later PR).
 *
 * URL: `POST /api/webhooks/leads/<LEAD_WEBHOOK_SECRET>`
 *
 * Payload shape:
 * ```json
 * {
 *   "source": "cold_call",
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
 *   }
 * }
 * ```
 *
 * Response: 200 with `{ property_id, was_duplicate }`. Idempotent on
 * the property's normalized address — a second submission for the
 * same address returns the existing id with `was_duplicate=true`,
 * never creates a duplicate row.
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

export async function POST(
  request: Request,
  context: { params: Promise<{ secret: string }> },
): Promise<NextResponse> {
  const { secret } = await context.params;

  const expected = process.env.LEAD_WEBHOOK_SECRET;
  if (!expected) {
    reportError(new Error("LEAD_WEBHOOK_SECRET is not configured"), {
      tags: { surface: "lead_webhook" },
    });
    return NextResponse.json(
      { error: "Webhook not configured" },
      { status: 503 },
    );
  }
  if (secret !== expected) {
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

  if (!body.source || !LEAD_SOURCES.includes(body.source as LeadSource)) {
    return NextResponse.json(
      {
        error: `'source' is required and must be one of: ${LEAD_SOURCES.join(", ")}.`,
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

  // Service-role client — webhook has no user session.
  const supabase = createSupabaseClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  const result = await createLead(supabase, {
    source: body.source as LeadSource,
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
      extra: { source: body.source },
    });
    return NextResponse.json(
      { error: result.error.message },
      { status: 500 },
    );
  }

  return NextResponse.json({
    property_id: result.data.propertyId,
    was_duplicate: result.data.wasDuplicate,
    contact_id: result.data.contactId,
  });
}
