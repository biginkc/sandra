import { normalizePhone } from "@/lib/csv/normalize";
import { STATE_TO_TZ } from "@/lib/messaging/quiet-hours";

export type DialerPhoneLabel =
  | "homeowner.phone_1"
  | "homeowner.phone_2"
  | "homeowner.phone_3";

export type DialerBatchItemSnapshot = {
  property_id: string;
  contact_id: string;
  phone_e164: string;
  phone_label: DialerPhoneLabel;
  state: string;
  timezone: string;
  calling_window_start_hour: number;
  calling_window_end_hour: number;
};

export function normalizeToE164(raw: string | null | undefined): string | null {
  return normalizePhone(raw);
}

export function buildSnapshotsForProperty(
  property: { id: string; state: string | null | undefined },
  contact: {
    id: string;
    phone_1: string | null;
    phone_2: string | null;
    phone_3: string | null;
  },
): DialerBatchItemSnapshot[] {
  const state = (property.state ?? "").trim().toUpperCase();
  const timezone = STATE_TO_TZ[state];
  if (!timezone) return [];

  const phones: Array<[DialerPhoneLabel, string | null]> = [
    ["homeowner.phone_1", contact.phone_1],
    ["homeowner.phone_2", contact.phone_2],
    ["homeowner.phone_3", contact.phone_3],
  ];

  return phones.flatMap(([phone_label, raw]) => {
    const phone_e164 = normalizeToE164(raw);
    if (!phone_e164) return [];

    return {
      property_id: property.id,
      contact_id: contact.id,
      phone_e164,
      phone_label,
      state,
      timezone,
      calling_window_start_hour: 8,
      calling_window_end_hour: 21,
    };
  });
}
