import type { SubOperationModule } from "./types";

const VALID_STATUSES = [
  "prospect",
  "new_lead",
  "contacted",
  "interested",
  "offer_sent",
  "offer_declined",
  "under_contract",
  "closed",
  "dead",
] as const;

type StatusValue = (typeof VALID_STATUSES)[number];

function normalizeStatus(raw: string): StatusValue | null {
  // Accept variants like "Offer Sent", "offer-sent", "OFFER_SENT" → "offer_sent".
  const canon = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return (VALID_STATUSES as readonly string[]).includes(canon)
    ? (canon as StatusValue)
    : null;
}

export const updatePropertyStatusOp: SubOperationModule = {
  id: "update-property-status",
  label: "Update property status",
  description:
    "Move properties through the pipeline (e.g., new_lead → contacted → offer_sent).",
  requiredColumns: ["Address", "Status"],
  optionalColumns: ["City", "State", "Zip"],
  exampleRows: [
    { Address: "123 Main St", Status: "contacted" },
    { Address: "456 Oak Ave", Status: "offer_sent" },
    { Address: "789 Pine Rd", Status: "closed" },
  ],

  async apply(ctx, args, options) {
    const { rowIndex, parsedRow, property } = args;
    const address = parsedRow.Address ?? "";
    const raw = (parsedRow.Status ?? "").trim();

    if (!raw) {
      return { kind: "unchanged", rowIndex, address, reason: "blank" };
    }
    if (property.is_dnc_locked) {
      return {
        kind: "rejected",
        rowIndex,
        address,
        reason: "dnc-locked",
        detail: "Permanent Do Not Contact records are read-only.",
      };
    }
    const normalized = normalizeStatus(raw);
    if (!normalized) {
      return {
        kind: "rejected",
        rowIndex,
        address,
        reason: "invalid-status",
        detail: `"${raw}" is not one of: ${VALID_STATUSES.join(", ")}`,
      };
    }
    if (normalized === property.status) {
      return { kind: "unchanged", rowIndex, address, reason: "no-change" };
    }
    if (!options.dryRun) {
      const { data, error } = await ctx.supabase
        .from("properties")
        .update({ status: normalized })
        .eq("id", property.id)
        .eq("is_dnc_locked", false)
        .select("id")
        .maybeSingle();
      if (error) {
        return {
          kind: "rejected",
          rowIndex,
          address,
          reason: "db-error",
          detail: error.message,
        };
      }
      if (!data) {
        return {
          kind: "rejected",
          rowIndex,
          address,
          reason: "dnc-locked",
          detail: "The property became permanently Do Not Contact before the update saved.",
        };
      }
    }
    return {
      kind: "updated",
      rowIndex,
      address,
      before: { status: property.status },
      after: { status: normalized },
    };
  },
};
