import { normalizePhone } from "@/lib/csv/normalize";

type SmsMessageAddressRow = {
  direction: string;
  from_address: string | null;
  to_address: string | null;
};

type SmsRouteMessageRow = SmsMessageAddressRow & {
  channel?: string | null;
  status: string;
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

export function isSmsRouteAuthoritative(row: SmsRouteMessageRow): boolean {
  if (row.channel && row.channel !== "sms") return false;
  return (
    (row.direction === "inbound" && row.status === "received") ||
    (row.direction === "outbound" &&
      (row.status === "sent" || row.status === "delivered"))
  );
}

/**
 * Select the newest route that was actually established with the provider.
 * Rows must be ordered oldest-to-newest. Pending, queued, paused, and failed
 * attempts remain visible in the timeline but can never retarget a reply.
 */
export function findLatestAuthoritativeSmsRoute<
  T extends SmsRouteMessageRow,
>(
  rows: readonly T[],
): { message: T; parties: SmsParties } | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const message = rows[index]!;
    if (!isSmsRouteAuthoritative(message)) continue;
    const parties = deriveSmsParties(message);
    if (!parties.customerPhone || !parties.businessPhone) continue;
    return { message, parties };
  }
  return null;
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
