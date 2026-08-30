import { createHash } from "node:crypto";

import { NextResponse } from "next/server";

import { normalizeAddress } from "@/lib/csv/normalize";
import { reportError } from "@/lib/errors/report";

import { authenticateSwitchboardPreference } from "../_lib/auth";

const MAX_IDENTITY_LENGTH = 128;
const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_EVENT_FUTURE_SKEW_MS = 5 * 60 * 1000;
const SWITCHBOARD_EVENT_SOURCE = "provider_call";
const SWITCHBOARD_EVENT_TYPE = "contact_preference.explicit";
const E164 = /^\+[1-9][0-9]{7,14}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const INTENT_CATEGORIES = new Set([
  "explicit_not_interested",
  "explicit_do_not_contact",
  "explicit_not_interested_and_do_not_contact",
]);
const INTENT_MARKERS = {
  explicit_not_interested: "analysis:property_disposition",
  explicit_do_not_contact: "analysis:global_dnc_requested",
  explicit_not_interested_and_do_not_contact: "analysis:both",
} as const;

type PreferenceRequest = {
  event_id: string;
  event_source: string;
  event_type: string;
  source_event_id: string;
  provider_call_id: string;
  intent_marker_id: string;
  conversation_id?: string;
  provider_timestamp: string;
  correlation_id: string;
  caller_phone_e164: string;
  property_disposition?: "not_interested";
  global_dnc_requested: boolean;
  manual_review_required: boolean;
  address?: {
    line1: string;
    city?: string;
    state?: string;
    postal_code?: string;
  };
  intent_evidence: {
    category: string;
    intent_marker_id: string;
    evidence_sha256: string;
  };
};

function boundedString(value: unknown, allowNull = false): string | null {
  if (allowNull && (value === null || value === undefined)) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_IDENTITY_LENGTH
    ? trimmed
    : null;
}

function optionalAddress(
  value: unknown,
): PreferenceRequest["address"] | null | undefined {
  if (value === undefined) return null;
  if (value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const address = value as Record<string, unknown>;
  const line1 = boundedString(address.line1);
  if (!line1) return undefined;
  const city = boundedString(address.city, true);
  const state = boundedString(address.state, true);
  const postalCode = boundedString(address.postal_code, true);
  if (
    ("city" in address && !city) ||
    ("state" in address && !state) ||
    ("postal_code" in address && !postalCode)
  ) {
    return undefined;
  }
  if (state && !/^[A-Za-z]{2}$/.test(state)) return undefined;
  return {
    line1,
    ...(city ? { city } : {}),
    ...(state ? { state: state.toUpperCase() } : {}),
    ...(postalCode ? { postal_code: postalCode } : {}),
  };
}

function parseRequest(rawBody: string): PreferenceRequest | null {
  let value: unknown;
  try {
    value = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const evidence = body.intent_evidence;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return null;
  }
  const evidenceRecord = evidence as Record<string, unknown>;

  const required = {
    event_id: boundedString(body.event_id),
    event_source: boundedString(body.event_source),
    event_type: boundedString(body.event_type),
    source_event_id: boundedString(body.source_event_id),
    provider_call_id: boundedString(body.provider_call_id),
    intent_marker_id: boundedString(body.intent_marker_id),
    correlation_id: boundedString(body.correlation_id),
    caller_phone_e164: boundedString(body.caller_phone_e164),
    evidence_category: boundedString(evidenceRecord.category),
    evidence_marker_id: boundedString(evidenceRecord.intent_marker_id),
    evidence_hash: boundedString(evidenceRecord.evidence_sha256),
  };
  if (Object.values(required).some((entry) => entry === null)) return null;

  const conversationId = boundedString(body.conversation_id, true);
  if (body.conversation_id !== undefined && !conversationId) return null;
  const address = optionalAddress(body.address);
  if (address === undefined) return null;
  const providerTimestamp = boundedString(body.provider_timestamp);
  if (!providerTimestamp || Number.isNaN(Date.parse(providerTimestamp))) {
    return null;
  }
  const providerTime = Date.parse(providerTimestamp);
  const now = Date.now();
  if (
    providerTime < now - MAX_EVENT_AGE_MS ||
    providerTime > now + MAX_EVENT_FUTURE_SKEW_MS
  ) {
    return null;
  }
  if (!E164.test(required.caller_phone_e164!)) return null;
  if (!SHA256.test(required.evidence_hash!)) return null;
  if (!INTENT_CATEGORIES.has(required.evidence_category!)) return null;
  if (required.intent_marker_id !== required.evidence_marker_id) return null;
  if (typeof body.global_dnc_requested !== "boolean") return null;
  if (typeof body.manual_review_required !== "boolean") return null;
  if (
    required.event_source !== SWITCHBOARD_EVENT_SOURCE ||
    required.event_type !== SWITCHBOARD_EVENT_TYPE
  ) {
    return null;
  }
  if (
    body.property_disposition !== undefined &&
    body.property_disposition !== "not_interested"
  ) {
    return null;
  }

  const propertyDisposition = body.property_disposition ?? null;
  if (!propertyDisposition && !body.global_dnc_requested) return null;
  const category = required.evidence_category!;
  const expectedMarker =
    INTENT_MARKERS[category as keyof typeof INTENT_MARKERS];
  if (!expectedMarker || required.intent_marker_id !== expectedMarker) {
    return null;
  }
  const expectedEvidenceHash = createHash("sha256")
    .update(
      `switchboard_contact_preference_v1\0${required.event_id}\0${category}\0${expectedMarker}`,
      "utf8",
    )
    .digest("hex");
  if (required.evidence_hash !== expectedEvidenceHash) return null;
  if (
    category === "explicit_not_interested" &&
    (propertyDisposition !== "not_interested" ||
      body.global_dnc_requested !== false)
  ) {
    return null;
  }
  if (
    category === "explicit_do_not_contact" &&
    (propertyDisposition !== null || body.global_dnc_requested !== true)
  ) {
    return null;
  }
  if (
    category === "explicit_not_interested_and_do_not_contact" &&
    (propertyDisposition !== "not_interested" ||
      body.global_dnc_requested !== true)
  ) {
    return null;
  }
  if (
    propertyDisposition === "not_interested" &&
    category !== "explicit_not_interested" &&
    category !== "explicit_not_interested_and_do_not_contact"
  ) {
    return null;
  }
  if (
    body.global_dnc_requested &&
    category !== "explicit_do_not_contact" &&
    category !== "explicit_not_interested_and_do_not_contact"
  ) {
    return null;
  }

  return {
    event_id: required.event_id!,
    event_source: required.event_source!,
    event_type: required.event_type!,
    source_event_id: required.source_event_id!,
    provider_call_id: required.provider_call_id!,
    intent_marker_id: required.intent_marker_id!,
    ...(conversationId ? { conversation_id: conversationId } : {}),
    provider_timestamp: new Date(providerTimestamp).toISOString(),
    correlation_id: required.correlation_id!,
    caller_phone_e164: required.caller_phone_e164!,
    ...(propertyDisposition === "not_interested"
      ? { property_disposition: propertyDisposition }
      : {}),
    global_dnc_requested: body.global_dnc_requested,
    manual_review_required: body.manual_review_required,
    ...(address ? { address } : {}),
    intent_evidence: {
      category,
      intent_marker_id: required.evidence_marker_id!,
      evidence_sha256: required.evidence_hash!,
    },
  };
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const auth = await authenticateSwitchboardPreference(request);
    if (!auth.ok) return auth.response;

    const idempotencyKey = request.headers.get("idempotency-key")?.trim();
    if (!idempotencyKey || idempotencyKey.length > MAX_IDENTITY_LENGTH) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    const body = parseRequest(auth.rawBody);
    if (!body || body.event_id !== idempotencyKey) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    if (body.manual_review_required && !body.global_dnc_requested) {
      return NextResponse.json(
        { error: "preference_not_applied" },
        { status: 422 },
      );
    }

    const addressNormalized = body.address
      ? normalizeAddress(body.address.line1)
      : null;
    if (body.address && !addressNormalized) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    const requestHash = createHash("sha256")
      .update("switchboard_contact_preferences\0")
      .update(auth.rawBody)
      .digest("hex");

    const rpcClient = auth.serviceClient as unknown as {
      rpc(
        name: string,
        args: Record<string, unknown>,
      ): Promise<{
        data: { outcome?: string } | null;
        error: { message: string } | null;
      }>;
    };
    const { data, error } = await rpcClient.rpc(
      "apply_switchboard_contact_preferences",
      {
        p_org_id: auth.orgId,
        p_consumer_id: auth.consumerId,
        p_idempotency_key: idempotencyKey,
        p_request_hash: requestHash,
        p_event_source: body.event_source,
        p_event_type: body.event_type,
        p_source_event_id: body.source_event_id,
        p_provider_call_id: body.provider_call_id,
        p_intent_marker_id: body.intent_marker_id,
        p_conversation_id: body.conversation_id ?? null,
        p_provider_timestamp: body.provider_timestamp,
        p_correlation_id: body.correlation_id,
        p_caller_phone_e164: body.caller_phone_e164,
        p_property_disposition: body.manual_review_required
          ? null
          : (body.property_disposition ?? null),
        p_global_dnc_requested: body.global_dnc_requested,
        p_manual_review_required: body.manual_review_required,
        p_evidence_category: body.intent_evidence.category,
        p_evidence_sha256: body.intent_evidence.evidence_sha256,
        p_address_normalized: addressNormalized,
        p_address_city: body.address?.city ?? null,
        p_address_state: body.address?.state ?? null,
        p_address_postal_code: body.address?.postal_code ?? null,
      },
    );
    if (error) throw error;

    const outcome = (data as { outcome?: string } | null)?.outcome;
    if (outcome === "idempotency_conflict") {
      return NextResponse.json({ error: "conflict" }, { status: 409 });
    }
    if (outcome === "preference_not_applied") {
      return NextResponse.json(
        { error: "preference_not_applied" },
        { status: 422 },
      );
    }
    if (outcome !== "applied" && outcome !== "replayed") {
      throw new Error("Unexpected Switchboard preference RPC outcome");
    }
    return NextResponse.json({ status: "applied" });
  } catch {
    reportError(new Error("switchboard_contact_preference_internal_error"), {
      tags: { surface: "switchboard_contact_preferences" },
    });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
