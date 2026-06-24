import type { SupabaseClient } from "@supabase/supabase-js";

import { normalizePhone } from "@/lib/csv/normalize";
import { reportError } from "@/lib/errors/report";
import { recordConsentEvent } from "@/lib/messaging/consent";
import { pauseContactEnrollments } from "@/lib/sequences/enrollment";
import type { Database, Json } from "@/lib/supabase/types";

export type ApplyPhoneLevelOptOutInput = {
  contactId: string | null;
  fromPhone: string;
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
  const contactIds = await loadAllContactIdsByPhone(supabase, input.fromPhone);
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
          fromPhone: input.fromPhone,
          surface: input.surface,
        },
      });
    }
    await supabase
      .from("contacts")
      .update({
        sms_opted_out: true,
        sms_opted_out_at: input.occurredAt.toISOString(),
      })
      .eq("id", contactId);
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
        extra: { contactId, fromPhone: input.fromPhone },
      });
    }
  }
}

export async function loadAllContactIdsByPhone(
  supabase: SupabaseClient<Database>,
  rawPhone: string,
): Promise<Set<string>> {
  const normalizedPhone = normalizePhone(rawPhone);
  if (!normalizedPhone) return new Set<string>();

  const results = await Promise.all([
    supabase.from("contacts").select("id").eq("phone_1", normalizedPhone),
    supabase.from("contacts").select("id").eq("phone_2", normalizedPhone),
    supabase.from("contacts").select("id").eq("phone_3", normalizedPhone),
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
