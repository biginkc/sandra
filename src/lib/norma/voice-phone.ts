import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

export type VoicePhoneContact = {
  phone_1: string | null;
  phone_2: string | null;
  phone_3: string | null;
};

export type VoicePhoneChoice = { phoneE164: string; slot: 1 | 2 | 3 };

/**
 * US number -> +1XXXXXXXXXX, else null. Mirrors fn_norma_eligibility: 10
 * digits, or 11 starting with 1; and a value written with a leading "+" must
 * be exactly +1 and 10 digits (so "+44 12 3456 7890" can never become a US
 * number). Non-US numbers are never voice-dialled.
 */
export function toUsVoiceE164(raw: string | null | undefined): string | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  const digits = text.replace(/\D/g, "");
  if (text.startsWith("+") && !(digits.length === 11 && digits.startsWith("1"))) return null;
  let e164: string | null = null;
  if (digits.length === 10) e164 = `+1${digits}`;
  else if (digits.length === 11 && digits.startsWith("1")) e164 = `+${digits}`;
  if (!e164 || !/^\+1[2-9][0-9]{9}$/.test(e164)) return null;
  return e164;
}

/**
 * Voice phone selection, separate from `selectBestSmsPhone`: SMS ranks mobiles
 * first and only falls back to a landline, but a voice call can reach any
 * callable US number, so this takes the first slot in order that is a US
 * number and has not been reached as "wrong number" by Norma.
 */
export function selectVoicePhone(
  contact: VoicePhoneContact | null | undefined,
  wrongNumbers: ReadonlySet<string> = new Set(),
): VoicePhoneChoice | null {
  if (!contact) return null;
  for (const slot of [1, 2, 3] as const) {
    const phoneE164 = toUsVoiceE164(contact[`phone_${slot}`]);
    if (phoneE164 && !wrongNumbers.has(phoneE164)) return { phoneE164, slot };
  }
  return null;
}

/** Numbers Norma already completed as wrong_number for this org. */
export async function loadNormaWrongNumbers(
  client: SupabaseClient<Database>,
  orgId: string,
  candidates: string[],
): Promise<Set<string>> {
  if (candidates.length === 0) return new Set();
  const { data, error } = await client
    .from("norma_call_requests")
    .select("phone_e164")
    .eq("org_id", orgId)
    .eq("status", "completed")
    .eq("outcome", "wrong_number")
    .in("phone_e164", candidates);
  if (error) throw new Error(`norma wrong-number lookup failed: ${error.message}`);
  return new Set((data ?? []).map((row) => row.phone_e164));
}
