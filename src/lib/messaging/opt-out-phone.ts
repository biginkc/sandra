import type { SupabaseClient } from "@supabase/supabase-js";

import { normalizePhone } from "@/lib/csv/normalize";
import { reportError } from "@/lib/errors/report";
import { recordConsentEvent } from "@/lib/messaging/consent";
import { pauseContactEnrollments } from "@/lib/sequences/enrollment";
import type { Database, Json } from "@/lib/supabase/types";

export type ApplyPhoneLevelOptOutInput = {
  contactId: string | null;
  fromPhone: string;
  orgId: string;
  source: string;
  sourceDetail: Json;
  occurredAt: Date;
  providerId: string;
  surface: "stop" | "dnc";
  idempotencyKey: string;
};

export async function applyPhoneLevelOptOut(
  supabase: SupabaseClient<Database>,
  input: ApplyPhoneLevelOptOutInput,
) {
  let suppressionError: unknown = null;
  try {
    await recordSmsPhoneSuppression(supabase, {
      contactId: input.contactId,
      fromPhone: input.fromPhone,
      orgId: input.orgId,
      source: input.source,
      sourceDetail: input.sourceDetail,
      occurredAt: input.occurredAt,
      providerId: input.providerId,
    });
  } catch (e) {
    reportError(e, {
      tags: { surface: `${input.providerId}_webhook_phone_suppression_record` },
      extra: {
        contactId: input.contactId,
        hasPhone: Boolean(input.fromPhone),
        surface: input.surface,
      },
    });
    suppressionError = e;
  }

  const contactIds = await loadAllContactIdsByPhone(
    supabase,
    input.fromPhone,
    input.orgId,
  );
  if (input.contactId) {
    contactIds.add(input.contactId);
  }
  for (const contactId of contactIds) {
    try {
      await recordConsentEvent(supabase, {
        contactId,
        channel: "sms",
        eventType: "opt_out",
        source: input.source,
        sourceDetail: input.sourceDetail,
        occurredAt: input.occurredAt,
        idempotencyKey: input.idempotencyKey,
      });
    } catch (e) {
      // Compliance enforcement beats audit perfection: if a contact row
      // has drifted or a replay-safe insert races oddly, still flip the
      // opt-out bit and stop future sends rather than 500ing the webhook.
      reportError(e, {
        tags: { surface: `${input.providerId}_webhook_opt_out_record` },
        extra: {
          contactId,
          hasPhone: Boolean(input.fromPhone),
          surface: input.surface,
        },
      });
    }
    const { error: contactUpdateError } = await supabase
      .from("contacts")
      .update({
        sms_opted_out: true,
        sms_opted_out_at: input.occurredAt.toISOString(),
      })
      .eq("id", contactId);
    if (contactUpdateError) {
      throw new Error(`applyPhoneLevelOptOut contact update: ${contactUpdateError.message}`);
    }
    try {
      await pauseContactEnrollments(supabase, {
        contactId,
        reason: "consent_revoked",
        permanent: true,
      });
    } catch (e) {
      reportError(e, {
        tags: {
          surface: `${input.providerId}_webhook_sequence_pause_${input.surface}`,
        },
        extra: { contactId, hasPhone: Boolean(input.fromPhone) },
      });
    }
  }
  if (suppressionError) {
    throw suppressionError;
  }
}

export async function recordSmsPhoneSuppression(
  supabase: SupabaseClient<Database>,
  input: {
    contactId: string | null;
    fromPhone: string;
    orgId: string;
    source: string;
    sourceDetail: Json;
    occurredAt: Date;
    providerId: string;
  },
): Promise<void> {
  const phone = normalizePhone(input.fromPhone);
  if (!phone) {
    reportError(new Error("recordSmsPhoneSuppression missing normalized phone"), {
      tags: { surface: "sms_phone_suppression_missing_phone" },
      extra: {
        contactId: input.contactId,
        hasPhone: Boolean(input.fromPhone),
        providerId: input.providerId,
        source: input.source,
      },
    });
    return;
  }

  const timestamp = input.occurredAt.toISOString();
  const { error } = await supabase
    .from("sms_phone_suppressions")
    .upsert(
      {
        channel: "sms",
        org_id: input.orgId,
        phone_e164: phone,
        source: input.source,
        source_detail: input.sourceDetail,
        first_contact_id: input.contactId,
        provider: input.providerId,
        suppressed_at: timestamp,
        updated_at: timestamp,
      },
      { onConflict: "org_id,channel,phone_e164" },
    );
  if (error) {
    throw new Error(`recordSmsPhoneSuppression: ${error.message}`);
  }
}

export async function isSmsPhoneSuppressed(
  supabase: SupabaseClient<Database>,
  rawPhone: string | null | undefined,
  orgId: string | null | undefined,
): Promise<boolean> {
  const phone = normalizePhone(rawPhone ?? "");
  if (!phone || !orgId) return false;
  const { data, error } = await supabase
    .from("sms_phone_suppressions")
    .select("id")
    .eq("org_id", orgId)
    .eq("channel", "sms")
    .eq("phone_e164", phone)
    .limit(1);
  if (error) {
    reportError(new Error(error.message), {
      tags: { surface: "sms_phone_suppression_lookup" },
      extra: { normalizedPhonePresent: Boolean(phone) },
    });
    throw new Error(`isSmsPhoneSuppressed: ${error.message}`);
  }
  return (data ?? []).length > 0;
}

export async function loadSuppressedSmsPhoneSet(
  supabase: SupabaseClient<Database>,
  rawPhones: Iterable<string | null | undefined>,
  orgId: string | null | undefined,
): Promise<Set<string>> {
  if (!orgId) return new Set<string>();
  const phones = Array.from(
    new Set(
      Array.from(rawPhones)
        .map((phone) => normalizePhone(phone ?? ""))
        .filter((phone): phone is string => typeof phone === "string"),
    ),
  );
  if (phones.length === 0) return new Set<string>();

  const { data, error } = await supabase
    .from("sms_phone_suppressions")
    .select("phone_e164")
    .eq("org_id", orgId)
    .eq("channel", "sms")
    .in("phone_e164", phones);
  if (error) {
    reportError(new Error(error.message), {
      tags: { surface: "sms_phone_suppression_bulk_lookup" },
      extra: { count: phones.length },
    });
    throw new Error(`loadSuppressedSmsPhoneSet: ${error.message}`);
  }
  return new Set((data ?? []).map((row) => row.phone_e164));
}

async function loadAllContactIdsByPhone(
  supabase: SupabaseClient<Database>,
  rawPhone: string,
  orgId: string,
): Promise<Set<string>> {
  const normalizedPhone = normalizePhone(rawPhone);
  if (!normalizedPhone) return new Set<string>();

  const results = await Promise.all([
    supabase
      .from("contacts")
      .select("id")
      .eq("org_id", orgId)
      .eq("phone_1", normalizedPhone),
    supabase
      .from("contacts")
      .select("id")
      .eq("org_id", orgId)
      .eq("phone_2", normalizedPhone),
    supabase
      .from("contacts")
      .select("id")
      .eq("org_id", orgId)
      .eq("phone_3", normalizedPhone),
  ]);

  const contactIds = new Set<string>();
  for (const result of results) {
    if (result.error) {
      throw new Error(`loadAllContactIdsByPhone: ${result.error.message}`);
    }
    for (const row of result.data ?? []) {
      contactIds.add(row.id);
    }
  }
  return contactIds;
}
