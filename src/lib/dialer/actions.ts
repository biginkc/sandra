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

function leadTarget(lead: LeadRow): SoftphoneTarget | null {
  const phone = phones(lead.homeowner).map(toPhoneE164).find(Boolean);
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
    const blocked = eligible.find((item) => item !== "callable");
    if (blocked) {
      return { ok: false, error: typeof blocked === "string" ? "This lead is not callable." : "This lead is blocked: " + blocked.blocked.replaceAll("_", " ") + "." };
    }
    await pausePropertyEnrollments(supabase, { propertyId: lead.id, reason: "call_in_progress" });
    return { ok: true, data: target };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not start the call." };
  }
}

export async function prepareManualCall(phone: string): Promise<SoftphoneActionResult<SoftphoneTarget>> {
  const phoneE164 = toPhoneE164(phone);
  if (!phoneE164) return { ok: false, error: "Enter a valid 10-digit number." };
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
  callback?: CallbackInput;
}): Promise<SoftphoneActionResult<{ activityId: string; callbackTaskId?: string }>> {
  if (!input.notes.trim()) return { ok: false, error: "Add a note to log the outcome." };
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: "Not signed in." };
    const { data: membership, error: membershipError } = await supabase.from("memberships").select("org_id").eq("user_id", user.id).limit(1).maybeSingle();
    if (membershipError || !membership) return { ok: false, error: membershipError?.message ?? "No organization membership." };

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

    let callbackTaskId: string | undefined;
    if (input.callback) {
      if (!input.target.propertyId) return { ok: false, error: "A manual dial cannot schedule a lead callback." };
      const timezone = await getMemberTimezone(user.id);
      const resolvedZone = timezone.ok ? timezone.data : input.callback.timeZone;
      const booked = await bookAppointment({
        propertyId: input.target.propertyId,
        contactId: input.target.contactId ?? undefined,
        assigneeId: user.id,
        date: input.callback.date,
        time: input.callback.time,
        timeZone: resolvedZone,
        durationMinutes: 30,
        title: `Call back ${input.target.address ?? "lead"}`,
        note: input.notes.trim(),
        idempotencyKey: crypto.randomUUID(),
      });
      if (!booked.ok) return { ok: false, error: booked.error.message };
      callbackTaskId = booked.data.taskId;
    }

    if (input.target.propertyId) {
      const dispo = await setOutreachDispo(input.target.propertyId, input.disposition);
      if (!dispo.ok) return { ok: false, error: dispo.error };
    }

    const { data: activity, error: activityError } = await supabase.from("call_activities").insert({
      org_id: membership.org_id,
      property_id: input.target.propertyId,
      contact_id: input.target.contactId,
      jitter_attempt_id: `sandra-${crypto.randomUUID()}`,
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
    }).select("id").single();
    if (activityError || !activity) return { ok: false, error: activityError?.message ?? "The call activity was not saved." };

    if (input.target.propertyId && input.disposition !== "dnc") {
      await resumeByProperty(supabase, { propertyId: input.target.propertyId });
    }
    return { ok: true, data: { activityId: activity.id, callbackTaskId } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not save the call." };
  }
}
