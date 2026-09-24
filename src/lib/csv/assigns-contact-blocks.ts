import { normalizePhone } from "./normalize";
import type { PhoneLineType } from "@/lib/messaging/line-type";

export type AssignsPhone = {
  value?: string;
  type?: string;
  sourceType?: string;
  activityScore?: string;
  dnc?: string;
  litigator?: string;
  email?: string;
};

export type AssignsContactBlock = {
  sourceIdentity?: string;
  position?: number;
  name?: string;
  type?: string;
  phones?: AssignsPhone[];
  usedAlternateSource?: string;
};

export function parseAssignsContactBlocks(value: unknown): AssignsContactBlock[] {
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new Error("not an array");
    return parsed as AssignsContactBlock[];
  } catch {
    throw new Error("Assigns contact blocks could not be parsed");
  }
}

/** Every phone whose source label is still unknown to Sandra. */
export function unknownAssignsPhones(value: unknown): string[] {
  return parseAssignsContactBlocks(value).flatMap((block) =>
    (block.phones ?? [])
      .filter((phone) => phone.type === "unknown")
      .map((phone) => normalizePhone(phone.value ?? ""))
      .filter((phone): phone is string => !!phone),
  );
}

/**
 * Apply classifications to the adapter envelope. Original vendor labels stay
 * in Assigns Source Row; only the import-operational contact envelope changes.
 */
export function applyAssignsPhoneTypes(
  value: unknown,
  classified: ReadonlyMap<string, PhoneLineType>,
): { value: string; labeledSlots: number } {
  const blocks = parseAssignsContactBlocks(value);
  let labeledSlots = 0;
  const next = blocks.map((block) => ({
    ...block,
    phones: (block.phones ?? []).map((phone) => {
      if (phone.type !== "unknown") return phone;
      const number = normalizePhone(phone.value ?? "");
      const type = number ? classified.get(number) : undefined;
      if (type !== "mobile" && type !== "landline") return phone;
      labeledSlots++;
      return { ...phone, type };
    }),
  }));
  return { value: JSON.stringify(next), labeledSlots };
}
