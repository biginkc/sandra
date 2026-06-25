import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { normalizePhone } from "@/lib/csv/normalize";
import { reportError } from "@/lib/errors/report";
import type { Database } from "@/lib/supabase/types";

const DEDUPE_WINDOW_MS = 2_000;
const FINGERPRINT_VERSION = 1;

type SemanticDedupeMode = "off" | "shadow" | "enforce";

export type InboundIntentClaim =
  | {
      duplicate: false;
      intentId: string | null;
      mode: SemanticDedupeMode;
    }
  | {
      duplicate: true;
      duplicateType: "semantic";
      intentId: string;
      mode: SemanticDedupeMode;
    };

export type InboundIntentInput = {
  orgId: string | null;
  providerId: string;
  externalId: string;
  from: string;
  to: string;
  body: string;
  receivedAt: Date;
  raw: unknown;
  mediaUrls: string[] | null;
  webhookEventId: string | null;
  contactId: string | null;
  propertyId: string | null;
  conversationId: string | null;
  routingResolution: string;
};

export async function claimInboundSmsIntent(
  supabase: SupabaseClient<Database>,
  input: InboundIntentInput,
): Promise<InboundIntentClaim> {
  const mode = inboundSemanticDedupeMode();
  if (mode === "off" || !input.orgId || input.providerId !== "sendillo") {
    return { duplicate: false, intentId: null, mode };
  }

  const fingerprint = buildIntentFingerprint(input);
  if (mode === "shadow") {
    const duplicate = await findOverlappingIntent(supabase, {
      orgId: input.orgId,
      dedupeScopeHash: fingerprint.dedupeScopeHash,
      receivedAt: input.receivedAt,
    });
    if (duplicate) {
      await recordDelivery(supabase, {
        input,
        intentId: duplicate.id,
        payloadSha256: fingerprint.payloadSha256,
        classification: "shadow_semantic",
      });
    }
    return { duplicate: false, intentId: null, mode };
  }

  const { data: inserted, error } = await supabase
    .from("sms_inbound_intents")
    .insert({
      org_id: input.orgId,
      provider: input.providerId,
      from_address: fingerprint.fromAddress,
      to_address: fingerprint.toAddress,
      body_fingerprint: fingerprint.bodyFingerprint,
      fingerprint_version: FINGERPRINT_VERSION,
      dedupe_scope_hash: fingerprint.dedupeScopeHash,
      received_at: input.receivedAt.toISOString(),
      dedupe_range: fingerprint.dedupeRange,
      contact_id: input.contactId,
      property_id: input.propertyId,
      conversation_id: input.conversationId,
      routing_resolution: input.routingResolution,
      first_provider_message_id: input.externalId,
      last_provider_message_id: input.externalId,
    })
    .select("id")
    .single();

  if (!error && inserted) {
    await recordDelivery(supabase, {
      input,
      intentId: inserted.id,
      payloadSha256: fingerprint.payloadSha256,
      classification: "canonical",
    });
    return { duplicate: false, intentId: inserted.id, mode };
  }

  if (error?.code !== "23P01") {
    throw new Error(
      `claimInboundSmsIntent insert failed: ${error?.message ?? "missing inserted row"}`,
    );
  }

  const duplicate = await findOverlappingIntent(supabase, {
    orgId: input.orgId,
    dedupeScopeHash: fingerprint.dedupeScopeHash,
    receivedAt: input.receivedAt,
  });
  if (!duplicate) {
    throw new Error(
      "claimInboundSmsIntent: exclusion conflict but no overlapping intent found",
    );
  }

  if (
    duplicate.first_provider_message_id === input.externalId &&
    duplicate.status !== "side_effects_complete"
  ) {
    await recordDelivery(supabase, {
      input,
      intentId: duplicate.id,
      payloadSha256: fingerprint.payloadSha256,
      classification: "canonical",
    });
    return { duplicate: false, intentId: duplicate.id, mode };
  }

  const { error: incrementError } = await supabase.rpc(
    "increment_sms_inbound_intent_duplicate",
    {
      p_intent_id: duplicate.id,
      p_last_provider_message_id: input.externalId,
    },
  );
  if (incrementError) {
    throw new Error(
      `increment_sms_inbound_intent_duplicate: ${incrementError.message}`,
    );
  }
  await recordDelivery(supabase, {
    input,
    intentId: duplicate.id,
    payloadSha256: fingerprint.payloadSha256,
    classification: "duplicate_semantic",
  });

  return {
    duplicate: true,
    duplicateType: "semantic",
    intentId: duplicate.id,
    mode,
  };
}

export async function markInboundSmsIntentMessageInserted(
  supabase: SupabaseClient<Database>,
  intentId: string | null | undefined,
  messageId: string | null | undefined,
): Promise<void> {
  if (!intentId || !messageId) return;
  const { error } = await supabase
    .from("sms_inbound_intents")
    .update({
      canonical_message_id: messageId,
      status: "message_inserted",
      updated_at: new Date().toISOString(),
    })
    .eq("id", intentId);
  if (error) {
    reportError(new Error(error.message), {
      tags: { surface: "sms_inbound_intent_message_inserted" },
      extra: { intentId, messageId },
    });
  }
}

export async function markInboundSmsIntentSideEffectsComplete(
  supabase: SupabaseClient<Database>,
  intentId: string | null | undefined,
): Promise<void> {
  if (!intentId) return;
  const { error } = await supabase
    .from("sms_inbound_intents")
    .update({
      status: "side_effects_complete",
      updated_at: new Date().toISOString(),
    })
    .eq("id", intentId);
  if (error) {
    reportError(new Error(error.message), {
      tags: { surface: "sms_inbound_intent_side_effects_complete" },
      extra: { intentId },
    });
  }
}

function inboundSemanticDedupeMode(): SemanticDedupeMode {
  const raw = process.env.SENDILLO_SEMANTIC_DEDUPE_MODE?.trim().toLowerCase();
  if (raw === "off" || raw === "shadow" || raw === "enforce") return raw;
  return "enforce";
}

function buildIntentFingerprint(input: InboundIntentInput): {
  bodyFingerprint: string;
  dedupeRange: string;
  dedupeScopeHash: string;
  fromAddress: string;
  payloadSha256: string;
  toAddress: string;
} {
  const fromAddress = normalizePhone(input.from) ?? input.from;
  const toAddress = normalizePhone(input.to) ?? input.to;
  const canonicalBody = canonicalizeSmsBody(input.body);
  const bodyFingerprint = sha256(canonicalBody);
  const mediaFingerprint = sha256(canonicalizeMediaUrls(input.mediaUrls));
  const threadKey =
    input.conversationId ??
    `contact:${input.contactId ?? "none"}:property:${input.propertyId ?? "none"}`;
  const dedupeScopeHash = sha256(
    [
      String(FINGERPRINT_VERSION),
      input.orgId ?? "unknown-org",
      input.providerId,
      fromAddress,
      toAddress,
      threadKey,
      bodyFingerprint,
      mediaFingerprint,
    ].join("\u001f"),
  );
  const start = input.receivedAt;
  const end = new Date(start.getTime() + DEDUPE_WINDOW_MS);
  return {
    bodyFingerprint,
    dedupeRange: `[${start.toISOString()},${end.toISOString()})`,
    dedupeScopeHash,
    fromAddress,
    payloadSha256: sha256(JSON.stringify(input.raw ?? null)),
    toAddress,
  };
}

function canonicalizeSmsBody(body: string): string {
  return body
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n+/g, "\n")
    .trim();
}

function canonicalizeMediaUrls(mediaUrls: string[] | null): string {
  if (!mediaUrls?.length) return "";
  return mediaUrls
    .map((url) => url.trim())
    .filter(Boolean)
    .sort()
    .join("\n");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function findOverlappingIntent(
  supabase: SupabaseClient<Database>,
  args: {
    orgId: string;
    dedupeScopeHash: string;
    receivedAt: Date;
  },
): Promise<{
  duplicate_count: number;
  first_provider_message_id: string;
  id: string;
  status: string;
} | null> {
  const minReceivedAt = new Date(
    args.receivedAt.getTime() - DEDUPE_WINDOW_MS,
  ).toISOString();
  const maxReceivedAt = new Date(
    args.receivedAt.getTime() + DEDUPE_WINDOW_MS,
  ).toISOString();
  const { data, error } = await supabase
    .from("sms_inbound_intents")
    .select("id, duplicate_count, first_provider_message_id, status")
    .eq("org_id", args.orgId)
    .eq("dedupe_scope_hash", args.dedupeScopeHash)
    .gte("received_at", minReceivedAt)
    .lte("received_at", maxReceivedAt)
    .order("received_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`findOverlappingIntent: ${error.message}`);
  }
  return data ?? null;
}

async function recordDelivery(
  supabase: SupabaseClient<Database>,
  args: {
    input: InboundIntentInput;
    intentId: string;
    payloadSha256: string;
    classification:
      | "canonical"
      | "duplicate_semantic"
      | "shadow_semantic";
  },
): Promise<void> {
  if (!args.input.orgId) return;
  const { error } = await supabase.from("sms_inbound_deliveries").insert({
    intent_id: args.intentId,
    org_id: args.input.orgId,
    webhook_event_id: args.input.webhookEventId,
    provider: args.input.providerId,
    provider_message_id: args.input.externalId,
    received_at: args.input.receivedAt.toISOString(),
    payload_sha256: args.payloadSha256,
    classification: args.classification,
  });
  if (error && error.code !== "23505") {
    throw new Error(`recordDelivery: ${error.message}`);
  }
}
