import { normalizePhone } from "@/lib/csv/normalize";

type SmsMessageAddressRow = {
  direction: string;
  from_address: string | null;
  to_address: string | null;
};

export type SmsParties = {
  customerPhone: string | null;
  businessPhone: string | null;
};

export function deriveSmsParties(row: SmsMessageAddressRow): SmsParties {
  if (row.direction === "inbound") {
    return {
      customerPhone: row.from_address,
      businessPhone: row.to_address,
    };
  }

  if (row.direction === "outbound") {
    return {
      customerPhone: row.to_address,
      businessPhone: row.from_address,
    };
  }

  return {
    customerPhone: null,
    businessPhone: null,
  };
}

export type ContactPhoneSlots = {
  phone_1: string | null;
  phone_2: string | null;
  phone_3: string | null;
};

export function findMatchingSavedContactPhone(
  contact: ContactPhoneSlots | null | undefined,
  phone: string | null | undefined,
): string | null {
  if (!contact || !phone) return null;
  const normalized = normalizePhone(phone);
  if (!normalized) return null;

  for (const candidate of [contact.phone_1, contact.phone_2, contact.phone_3]) {
    if (candidate && normalizePhone(candidate) === normalized) {
      return candidate;
    }
  }

  return null;
}
