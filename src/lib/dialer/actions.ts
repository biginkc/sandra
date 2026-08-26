"use server";

import { bookAppointment } from "@/components/appointments/book-appointment-action";
import { setOutreachDispo, type OutreachDispo } from "@/app/(dashboard)/messages/dispo-actions";
import { pausePropertyEnrollments, resumeByProperty } from "@/lib/sequences/enrollment";
import { classifyItem } from "@/lib/dialer/eligibility";
import { checkQuietHours } from "@/lib/messaging/quiet-hours";
import { formatPhoneE164, toPhoneE164 } from "@/lib/phone-format";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/types";
import { getMemberTimezone } from "@/components/appointments/book-appointment-action";
import { openCallCapability } from "./call-capability";

type Contact = Pick<
  Database["public"]["Tables"]["contacts"]["Row"],
  "id" | "first_name" | "last_name" | "entity_name" | "phone_1" | "phone_2" | "phone_3" | "do_not_contact" | "sms_opted_out"
>;

type LeadRow = {
  id: string;
  address: string;
  city: string;
  state: string;
  is_dnc_locked: boolean;
  homeowner_contact_id: string | null;
  homeowner: Contact | null;
};

export type SoftphoneTarget = {
  propertyId: string | null;
  contactId: string | null;
  phoneE164: string;
  maskedPhone: string;
  name: string;
  address: string | null;
  state: string | null;
  startedAt: string;
};

export type SoftphoneActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

function displayName(contact: Contact | null): string {
  if (!contact) return "Unknown homeowner";
  if (contact.entity_name?.trim()) return contact.entity_name.trim();
  return [contact.first_name, contact.last_name].filter(Boolean).join(" ") || "Unknown homeowner";
}

function phones(contact: Contact | null): string[] {
  if (!contact) return [];
  return [contact.phone_1, contact.phone_2, contact.phone_3].filter((phone): phone is string => Boolean(phone?.trim()));
}

function leadTarget(lead: LeadRow, preferredPhone?: string): SoftphoneTarget | null {
  const phone = preferredPhone ?? phones(lead.homeowner).map(toPhoneE164).find(Boolean);
  if (!phone) return null;
  return {
    propertyId: lead.id,
    contactId: lead.homeowner_contact_id,
    phoneE164: phone,
    maskedPhone: formatPhoneE164(phone) ?? phone,
    name: displayName(lead.homeowner),
    address: lead.address,
    state: lead.state,
    startedAt: new Date().toISOString(),
  };
}

async function getLead(supabase: Awaited<ReturnType<typeof createClient>>, propertyId: string): Promise<LeadRow | null> {
  const { data, error } = await supabase
    .from("properties")
    .select("id, address, city, state, is_dnc_locked, homeowner_contact_id, homeowner:contacts!properties_homeowner_contact_id_fkey(id, first_name, last_name, entity_name, phone_1, phone_2, phone_3, do_not_contact, sms_opted_out)")
    .eq("id", propertyId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as unknown as LeadRow | null) ?? null;
}

export async function prepareLeadCall(propertyId: string): Promise<SoftphoneActionResult<SoftphoneTarget>> {
  try {
    const supabase = await createClient();
    const lead = await getLead(supabase, propertyId);
    if (!lead) return { ok: false, error: "Lead not found." };
    const target = leadTarget(lead);
    if (!target || !lead.homeowner) return { ok: false, error: "This lead has no callable phone number." };
    const eligible = classifyItem({
      property: { id: lead.id, state: lead.state, is_dnc_locked: lead.is_dnc_locked },
      contact: {
        id: lead.homeowner.id,
        phone_1: lead.homeowner.phone_1,
        phone_2: lead.homeowner.phone_2,
        phone_3: lead.homeowner.phone_3,
        do_not_contact: lead.homeowner.do_not_contact,
        sms_opted_out: lead.homeowner.sms_opted_out,
      },
    });
    if (eligible.length === 0) {
      return { ok: false, error: "Calling is unavailable during quiet hours." };
    }
    const blocked = eligible.find((item) => item !== "callable");
    if (blocked) {
      return { ok: false, error: typeof blocked === "string" ? "This lead is not callable." : "This lead is blocked: " + blocked.blocked.replaceAll("_", " ") + "." };
    }
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return { ok: false, error: "Not signed in." };
    await pausePropertyEnrollments(supabase, {
      propertyId: lead.id,
      reason: "call_in_progress",
      actor: { actorType: "user", actorId: user.id },
    });
    return { ok: true, data: target };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not start the call." };
  }
}

/** Best-effort cleanup for a transport failure before wrap-up exists. */
export async function resumeFailedSoftphoneCall(propertyId: string): Promise<void> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    await resumeByProperty(supabase, {
      propertyId,
      actor: { actorType: "user", actorId: user.id },
    });
  } catch {
    // The scheduled call-in-progress sweeper is the durable backstop.
  }
}

export async function prepareManualCall(phone: string): Promise<SoftphoneActionResult<SoftphoneTarget>> {
  const phoneE164 = toPhoneE164(phone);
  if (!phoneE164) return { ok: false, error: "Enter a valid 10-digit number." };
  try {
    const supabase = await createClient();
    const contactSelect = "id, first_name, last_name, entity_name, phone_1, phone_2, phone_3, do_not_contact, sms_opted_out";
    const contactResults = await Promise.all([
      supabase.from("contacts").select(contactSelect).eq("phone_1", phoneE164),
      supabase.from("contacts").select(contactSelect).eq("phone_2", phoneE164),
      supabase.from("contacts").select(contactSelect).eq("phone_3", phoneE164),
    ]);
    const contactError = contactResults.find((result) => result.error)?.error;
    if (contactError) throw new Error(contactError.message);
    const contacts = new Map<string, Contact>();
    for (const result of contactResults) {
      for (const contact of (result.data ?? []) as unknown as Contact[]) {
        if ([contact.phone_1, contact.phone_2, contact.phone_3].some((value) => toPhoneE164(value) === phoneE164)) {
          contacts.set(contact.id, contact);
        }
      }
    }

    const contactIds = [...contacts.keys()];
    const propertyRows = contactIds.length
      ? await supabase
        .from("properties")
        .select("id, address, city, state, is_dnc_locked, homeowner_contact_id, homeowner:contacts!properties_homeowner_contact_id_fkey(id, first_name, last_name, entity_name, phone_1, phone_2, phone_3, do_not_contact, sms_opted_out)")
        .in("homeowner_contact_id", contactIds)
      : { data: [], error: null };
    if (propertyRows.error) throw new Error(propertyRows.error.message);
    const matchingLeads = (propertyRows.data ?? [])
      .map((row) => row as unknown as LeadRow)
      .filter((lead) => phones(lead.homeowner).some((value) => toPhoneE164(value) === phoneE164));

    const hasBlockedMatch = [...contacts.values()].some((contact) => contact.do_not_contact)
      || matchingLeads.some((lead) => lead.is_dnc_locked || lead.homeowner?.do_not_contact);
    if (hasBlockedMatch) {
      return { ok: false, error: "This number belongs to a DNC-locked lead" };
    }

    const linkedLead = matchingLeads.find((lead) => lead.homeowner && !lead.is_dnc_locked);
    if (linkedLead) {
      const quietHours = checkQuietHours(linkedLead.state);
      if (!quietHours.ok) return { ok: false, error: "Calling is unavailable during quiet hours." };
      const target = leadTarget(linkedLead, phoneE164);
      if (!target || !linkedLead.homeowner) return { ok: false, error: "This lead has no callable phone number." };
      const { data: { user }, error: authError } = await supabase.auth.getUser();
      if (authError || !user) return { ok: false, error: "Not signed in." };
      await pausePropertyEnrollments(supabase, {
        propertyId: linkedLead.id,
        reason: "call_in_progress",
        actor: { actorType: "user", actorId: user.id },
      });
      return { ok: true, data: target };
    }

    const quietHours = checkQuietHours("MO");
    if (!quietHours.ok) return { ok: false, error: "Calling is unavailable during quiet hours." };
    return {
      ok: true,
      data: {
        propertyId: null,
        contactId: null,
        phoneE164,
        maskedPhone: formatPhoneE164(phoneE164) ?? phoneE164,
        name: formatPhoneE164(phoneE164) ?? phoneE164,
        address: null,
        state: "MO",
        startedAt: new Date().toISOString(),
      },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not prepare the call." };
  }
}

export type DialerSearchResult = {
  propertyId: string;
  contactId: string;
  name: string;
  detail: string;
  phoneE164: string;
  address: string;
  state: string;
};

export async function searchDialerLeads(query: string): Promise<SoftphoneActionResult<DialerSearchResult[]>> {
  const normalized = query.trim();
  if (!normalized) return { ok: true, data: [] };
  try {
    const supabase = await createClient();
    const digits = normalized.replace(/\D/g, "");
    const escaped = normalized.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
    const [propertiesResult, contactsResult] = await Promise.all([
      supabase.from("properties").select("id, address, city, state, is_dnc_locked, homeowner_contact_id, homeowner:contacts!properties_homeowner_contact_id_fkey(id, first_name, last_name, entity_name, phone_1, phone_2, phone_3, do_not_contact, sms_opted_out)").eq("is_dnc_locked", false).or(`address.ilike.%${escaped}%,city.ilike.%${escaped}%,state.ilike.%${escaped}%`).limit(12),
      supabase.from("contacts").select("id").or(`first_name.ilike.%${escaped}%,last_name.ilike.%${escaped}%,entity_name.ilike.%${escaped}%${digits.length >= 3 ? `,phone_1.ilike.%${digits}%,phone_2.ilike.%${digits}%,phone_3.ilike.%${digits}%` : ""}`).limit(12),
    ]);
    if (propertiesResult.error) throw propertiesResult.error;
    if (contactsResult.error) throw contactsResult.error;
    const contactIds = (contactsResult.data ?? []).map((row) => row.id);
    const byContact = contactIds.length
      ? await supabase.from("properties").select("id, address, city, state, is_dnc_locked, homeowner_contact_id, homeowner:contacts!properties_homeowner_contact_id_fkey(id, first_name, last_name, entity_name, phone_1, phone_2, phone_3, do_not_contact, sms_opted_out)").eq("is_dnc_locked", false).in("homeowner_contact_id", contactIds).limit(12)
      : { data: [], error: null };
    if (byContact.error) throw byContact.error;
    const rows = new Map<string, LeadRow>();
    for (const row of [...(propertiesResult.data ?? []), ...(byContact.data ?? [])]) rows.set(row.id, row as unknown as LeadRow);
    const results: DialerSearchResult[] = [];
    for (const lead of rows.values()) {
      if (lead.is_dnc_locked || !lead.homeowner || lead.homeowner.do_not_contact) continue;
      const target = leadTarget(lead);
      if (!target || !lead.homeowner_contact_id) continue;
      results.push({
        propertyId: lead.id,
        contactId: lead.homeowner_contact_id,
        name: target.name,
        detail: `${lead.address} · ${target.maskedPhone}`,
        phoneE164: target.phoneE164,
        address: lead.address,
        state: lead.state,
      });
      if (results.length === 4) break;
    }
    return { ok: true, data: results };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not search leads." };
  }
}

export type DialerRecent = {
  id: string;
  propertyId: string | null;
  contactId: string | null;
  name: string;
  detail: string;
  phoneE164: string;
  when: string;
  missed: boolean;
};

export async function loadDialerRecents(): Promise<SoftphoneActionResult<DialerRecent[]>> {
  try {
    const supabase = await createClient();
    const { data: rows, error } = await supabase.from("call_activities").select("id, property_id, contact_id, phone_e164, started_at, outcome, property:properties(address, city, state, is_dnc_locked), contact:contacts(first_name, last_name, entity_name, do_not_contact)").eq("operator_user_id", (await supabase.auth.getUser()).data.user?.id ?? "").order("started_at", { ascending: false }).limit(10);
    if (error) throw error;
    const results: DialerRecent[] = [];
    for (const row of (rows ?? []) as unknown as Array<Record<string, unknown>>) {
      const property = row.property as { address?: string; city?: string; state?: string; is_dnc_locked?: boolean } | null;
      const contact = row.contact as Contact | null;
      if (property?.is_dnc_locked || contact?.do_not_contact) continue;
      const phone = String(row.phone_e164 ?? "");
      if (!phone) continue;
      const name = displayName(contact);
      const outcome = String(row.outcome ?? "unknown");
      results.push({
        id: String(row.id),
        propertyId: row.property_id ? String(row.property_id) : null,
        contactId: row.contact_id ? String(row.contact_id) : null,
        name: property ? name : "Manual dial",
        detail: property ? `${property.address ?? "Lead"} · ${formatPhoneE164(phone) ?? phone}` : `Manual dial · ${formatPhoneE164(phone) ?? phone}`,
        phoneE164: phone,
        when: row.started_at ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(String(row.started_at))) : "",
        missed: ["no_answer", "busy", "failed", "canceled"].includes(outcome),
      });
    }
    return { ok: true, data: results };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not load recent calls." };
  }
}

export type CallbackInput = { date: string; time: string; timeZone: string };

export async function completeSoftphoneCall(input: {
  target: SoftphoneTarget;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  outcome: "connected_human" | "failed";
  disposition: OutreachDispo;
  notes: string;
  wrapToken: string;
  /** Browser-held sealed Jitter call capability, when the real transport started. */
  callCapability?: string;
  callback?: CallbackInput;
}): Promise<SoftphoneActionResult<{ activityId: string; callbackTaskId?: string }>> {
  if (!input.notes.trim()) return { ok: false, error: "Add a note to log the outcome." };
  // wrapToken is interpolated into a PostgREST .or() filter below; a strict
  // UUID shape keeps client input out of filter grammar.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.wrapToken)) {
    return { ok: false, error: "Invalid call token." };
  }
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: "Not signed in." };
    const { data: membership, error: membershipError } = await supabase.from("memberships").select("org_id").eq("user_id", user.id).limit(1).maybeSingle();
    if (membershipError || !membership) return { ok: false, error: membershipError?.message ?? "No organization membership." };
    const rawJitterCallId = openCallCapability(input.callCapability, user.id);
    // Capability-less calls use the wrap token as their Sandra-side attempt
    // identity, while capability-backed calls use Jitter's call UUID. That
    // divergence is an accepted residual only for capability-less calls.
    const jitterAttemptId = `sandra-${rawJitterCallId ?? input.wrapToken}`;
    // A wrap-up may claim only its own row or a writeback-first row that has
    // not been claimed yet. The token fence prevents a later submission by
    // the same operator from overwriting a completed wrap-up for this attempt.
    // Claimable rows: this operator's own wrap (same token), a
    // writeback-first row already attributed to this operator but not yet
    // wrapped (token null), or a fully unclaimed writeback-first row.
    const activityMatchFilter = `and(operator_user_id.eq.${user.id},wrap_token.eq.${input.wrapToken}),and(operator_user_id.eq.${user.id},wrap_token.is.null),and(operator_user_id.is.null,wrap_token.is.null)`;

    if (input.target.propertyId) {
      const { data: property, error: propertyError } = await supabase
        .from("properties")
        .select("id, homeowner_contact_id")
        .eq("id", input.target.propertyId)
        .eq("org_id", membership.org_id)
        .maybeSingle();
      if (propertyError || !property) {
        return { ok: false, error: propertyError?.message ?? "Lead is not in your organization." };
      }
      if (input.target.contactId && property.homeowner_contact_id !== input.target.contactId) {
        return { ok: false, error: "The call target no longer matches the lead." };
      }
    }
    if (input.callback && !input.target.propertyId) {
      return { ok: false, error: "A manual dial cannot schedule a lead callback." };
    }

    const { data: replayActivity, error: replayActivityError } = await supabase
      .from("call_activities")
      .select("id, property_id, contact_id")
      .eq("org_id", membership.org_id)
      .eq("operator_user_id", user.id)
      .eq("wrap_token", input.wrapToken)
      .maybeSingle();
    if (replayActivityError) return { ok: false, error: replayActivityError.message };
    if (
      replayActivity &&
      ((input.target.propertyId && replayActivity.property_id !== input.target.propertyId) ||
        (input.target.contactId && replayActivity.contact_id !== input.target.contactId))
    ) {
      return { ok: false, error: "The call activity no longer matches the call target." };
    }

    let activity = replayActivity;
    let activityMatchedByAttempt = false;
    if (!activity) {
      const { data: existingActivity, error: existingActivityError } = await supabase
        .from("call_activities")
        .select("id, property_id, contact_id, operator_user_id")
        .eq("org_id", membership.org_id)
        .eq("provider", "sandra_softphone")
        .eq("jitter_attempt_id", jitterAttemptId)
        .or(activityMatchFilter)
        .limit(1)
        .maybeSingle();
      if (existingActivityError) return { ok: false, error: existingActivityError.message };
      if (existingActivity) {
        if (
          (input.target.propertyId && existingActivity.property_id !== input.target.propertyId) ||
          (input.target.contactId && existingActivity.contact_id !== input.target.contactId)
        ) {
          return { ok: false, error: "The call activity no longer matches the call target." };
        }
        activity = existingActivity;
        activityMatchedByAttempt = true;
      }
    }

    let activityValues = {
      org_id: membership.org_id,
      property_id: activity?.property_id ?? input.target.propertyId,
      contact_id: activity?.contact_id ?? input.target.contactId,
      jitter_attempt_id: jitterAttemptId,
      operator_user_id: user.id,
      started_at: input.startedAt,
      ended_at: input.endedAt,
      duration_seconds: Math.max(0, Math.floor(input.durationSeconds)),
      outcome: input.outcome,
      disposition: input.disposition,
      notes: input.notes.trim(),
      direction: "outbound",
      provider: "sandra_softphone",
      phone_e164: input.target.phoneE164,
      do_not_call_requested: input.disposition === "dnc",
      wrap_token: input.wrapToken,
    };
    let callbackTaskId: string | undefined;
    let dispositionSucceeded = false;
    let activityCreatedByWrapUp = false;
    try {
      if (activityMatchedByAttempt && activity) {
        // The attempt and target have been fenced to this operator/token, so
        // it is now safe to perform the authoritative DNC_LOCKED check before
        // replacing the writeback-first row's operator fields.
        if (!replayActivity && input.target.propertyId) {
          const dispo = await setOutreachDispo(input.target.propertyId, input.disposition);
          if (!dispo.ok) return { ok: false, error: dispo.error };
          dispositionSucceeded = true;
        }

        const { data: updatedActivity, error: activityError } = await supabase
          .from("call_activities")
          .update(activityValues)
          .eq("id", activity.id)
          .or(activityMatchFilter)
          .select("id")
          .maybeSingle();
        if (activityError || !updatedActivity) {
          return { ok: false, error: activityError?.message ?? "The call activity was not saved." };
        }
        activity = { ...activity, id: updatedActivity.id };
      } else if (!activity) {
        // An attempt row that exists but was not claimable above (another
        // operator, or an already-wrapped different token) must reject
        // BEFORE the disposition side effect runs.
        const { data: unclaimableRow, error: unclaimableError } = await supabase
          .from("call_activities")
          .select("id")
          .eq("org_id", membership.org_id)
          .eq("provider", "sandra_softphone")
          .eq("jitter_attempt_id", jitterAttemptId)
          .limit(1)
          .maybeSingle();
        if (unclaimableError) return { ok: false, error: unclaimableError.message };
        if (unclaimableRow) {
          return { ok: false, error: "The call activity was not saved." };
        }
        // Preserve origin/main's deliberate order: setOutreachDispo is the
        // authoritative DNC_LOCKED race check and must run before any row is
        // written, so a rejected disposition leaves nothing to clean up.
        // (A concurrent two-tab wrap-up losing the claim after the CRM
        // change is the accepted residual, unchanged from main.)
        if (!replayActivity && input.target.propertyId) {
          const dispo = await setOutreachDispo(input.target.propertyId, input.disposition);
          if (!dispo.ok) return { ok: false, error: dispo.error };
          dispositionSucceeded = true;
        }
        const { data: insertedActivity, error: activityError } = await supabase
          .from("call_activities")
          .insert(activityValues)
          .select("id")
          .maybeSingle();
        if (activityError && activityError.code !== "23505") {
          return { ok: false, error: activityError.message };
        }
        activity = insertedActivity
          ? {
              id: insertedActivity.id,
              property_id: activityValues.property_id,
              contact_id: activityValues.contact_id,
            }
          : null;
        activityCreatedByWrapUp = Boolean(activity);

        if (!activity) {
          const { data: existingActivity, error: existingActivityError } = await supabase
            .from("call_activities")
            .select("id, property_id, contact_id, operator_user_id")
            .eq("org_id", membership.org_id)
            .eq("provider", "sandra_softphone")
            .eq("jitter_attempt_id", jitterAttemptId)
            .or(activityMatchFilter)
            .limit(1)
            .maybeSingle();
          if (existingActivityError || !existingActivity) {
            return { ok: false, error: existingActivityError?.message ?? "The call activity was not saved." };
          }
          if (
            (input.target.propertyId && existingActivity.property_id !== input.target.propertyId) ||
            (input.target.contactId && existingActivity.contact_id !== input.target.contactId)
          ) {
            return { ok: false, error: "The call activity no longer matches the call target." };
          }
          activityValues = {
            ...activityValues,
            property_id: existingActivity.property_id ?? input.target.propertyId,
            contact_id: existingActivity.contact_id ?? input.target.contactId,
          };
          const { data: updatedActivity, error: updateActivityError } = await supabase
            .from("call_activities")
            .update(activityValues)
            .eq("id", existingActivity.id)
            .or(activityMatchFilter)
            .select("id")
            .maybeSingle();
          if (updateActivityError || !updatedActivity) {
            return { ok: false, error: updateActivityError?.message ?? "The call activity was not saved." };
          }
          activity = { ...existingActivity, id: updatedActivity.id };
        }
      }

      if (!activity) return { ok: false, error: "The call activity was not saved." };

      // fn_book_appointment owns the booked_appointment write. Supplying the
      // stable wrap token makes a retry after a lost response replay the same
      // booking instead of creating a second appointment.
      if (input.callback) {
        const timezone = await getMemberTimezone(user.id);
        const resolvedZone = timezone.ok ? timezone.data : input.callback.timeZone;
        const booked = await bookAppointment({
          propertyId: input.target.propertyId!,
          contactId: input.target.contactId ?? undefined,
          assigneeId: user.id,
          date: input.callback.date,
          time: input.callback.time,
          timeZone: resolvedZone,
          durationMinutes: 30,
          title: `Call back ${input.target.address ?? "lead"}`,
          note: input.notes.trim(),
          idempotencyKey: input.wrapToken,
        });
        if (!booked.ok) return { ok: false, error: booked.error.message };
        callbackTaskId = booked.data.taskId;

        // Two simultaneous same-token submissions can both pass the replay
        // read before either activity exists. If this request then loses the
        // activity insert race, its earlier disposition write may have landed
        // after the winning request booked the appointment. The booking RPC
        // correctly returns the existing task on the duplicate key, but does
        // not repeat its booked_appointment write. Repair only the exact stale
        // disposition this request wrote so a later, unrelated disposition is
        // never overwritten.
        if (booked.data.duplicate) {
          const { error: restoreBookedDispositionError } = await supabase
            .from("properties")
            .update({
              outreach_dispo: "booked_appointment",
              updated_at: new Date().toISOString(),
            })
            .eq("id", input.target.propertyId!)
            .eq("org_id", membership.org_id)
            .eq("outreach_dispo", input.disposition);
          if (restoreBookedDispositionError) {
            return { ok: false, error: restoreBookedDispositionError.message };
          }
        }
      }

      return { ok: true, data: { activityId: activity.id, callbackTaskId } };
    } finally {
      // A failed activity insert or appointment booking must not strand the
      // sequence pause created when the call began. This filter resumes only
      // the softphone-owned pause, never an inbound-reply or appointment pause.
      if (dispositionSucceeded && input.target.propertyId) {
        try {
          await resumeByProperty(supabase, {
            propertyId: input.target.propertyId,
            actor: { actorType: "user", actorId: user.id },
          });
        } catch {
          // The 30-minute call-in-progress sweeper is the durable backstop.
        }
      }
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not save the call." };
  }
}
