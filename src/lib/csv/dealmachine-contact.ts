import { normalizeName, normalizePhone, toBoolOrNull } from "./normalize";
import { lineTypeFromVendorLabel } from "@/lib/messaging/line-type";
export function parseDealMachineContact(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  const raw: unknown = JSON.parse(value);
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.values(raw).some((v) => typeof v !== "string")) throw new Error("DealMachine source row must contain string values");
  const row = raw as Record<string, string>;
  const sourceId = row.internal_person_id?.trim();
  if (!sourceId) throw new Error("DealMachine person ID is required");
  const names = row.person_full_name?.trim().split(/\s+/) ?? [];
  const phones = [1, 2, 3].map((slot) => ({ value: normalizePhone(row[`phone_${slot}`]), type: lineTypeFromVendorLabel(row[`people_phone_${slot}_type_id`]), dnc: toBoolOrNull(row[`is_phone_${slot}_dnc`]) === true }));
  for (const slot of [1, 2, 3]) {
    const flag = row[`is_phone_${slot}_dnc`]?.trim();
    if (row[`phone_${slot}`]?.trim() && flag && toBoolOrNull(flag) === null) {
      throw new Error(`DealMachine phone ${slot} has an unrecognized DNC flag`);
    }
  }
  const typed = phones.filter((p) => p.value && p.type !== "unknown");
  return { sourceId, row, phones, contact: {
    contact_type: "person" as const, first_name: normalizeName(names[0] ?? null), last_name: normalizeName(names.slice(1).join(" ") || null),
    phone_1: typed[0]?.value ?? null, phone_1_type: typed[0]?.type ?? "unknown",
    phone_2: typed[1]?.value ?? null, phone_2_type: typed[1]?.type ?? "unknown",
    phone_3: typed[2]?.value ?? null, phone_3_type: typed[2]?.type ?? "unknown",
    email: row.email_address_1?.trim().toLowerCase() || null, do_not_contact: phones.some((p) => p.value && p.dnc),
  } };
}
