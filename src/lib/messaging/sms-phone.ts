import { asLineType, type PhoneLineType } from "./line-type";

export type SmsPhoneContact = {
  phone_1: string | null;
  phone_1_type: string | null;
  phone_2: string | null;
  phone_2_type: string | null;
  phone_3: string | null;
  phone_3_type: string | null;
};

export type SmsPhoneChoice = {
  phone: string;
  lineType: PhoneLineType;
  slot: 1 | 2 | 3;
};

export type SmsPhoneAvailability = PhoneLineType | "none";

function phoneSlots(contact: SmsPhoneContact): SmsPhoneChoice[] {
  return ([1, 2, 3] as const).flatMap((slot) => {
    const phone = contact[`phone_${slot}`];
    if (!phone) return [];
    return [
      {
        phone,
        lineType: asLineType(contact[`phone_${slot}_type`]),
        slot,
      },
    ];
  });
}

/**
 * Choose the best outbound SMS destination from all saved contact phones.
 * Confirmed mobiles always win, even when a landline was saved first.
 */
export function selectBestSmsPhone(
  contact: SmsPhoneContact | null | undefined,
): SmsPhoneChoice | null {
  if (!contact) return null;
  const slots = phoneSlots(contact);
  return (
    slots.find((slot) => slot.lineType === "mobile") ??
    slots.find((slot) => slot.lineType === "unknown") ??
    slots.find((slot) => slot.lineType === "landline") ??
    null
  );
}

export function classifySmsPhoneAvailability(
  contact: SmsPhoneContact | null | undefined,
): SmsPhoneAvailability {
  return selectBestSmsPhone(contact)?.lineType ?? "none";
}
