import { lineTypeFromVendorLabel } from "@/lib/messaging/line-type";

import { normalizePhone } from "../normalize";

import type { SubOperationModule } from "./types";

type Role = "homeowner" | "agent";

export function buildPhonesOp(role: Role): SubOperationModule {
  const idSuffix = role === "homeowner" ? "homeowner-phones" : "agent-phones";
  const label = role === "homeowner"
    ? "Update homeowner phone numbers"
    : "Update agent phone numbers";
  const noContactReason = role === "homeowner" ? "no-homeowner" : "no-agent";
  const contactKey = role === "homeowner"
    ? "homeowner_contact_id"
    : "agent_contact_id";

  return {
    id: `update-${idSuffix}` as SubOperationModule["id"],
    label,
    description: `Overwrite the ${role}'s phone slots in order. Blank slots are left untouched. Each provided phone needs a matching "Phone N Type" (Mobile/Landline) — numbers without a line type are never saved.`,
    requiredColumns: ["Address", "Phone 1", "Phone 1 Type"],
    optionalColumns: [
      "Phone 2",
      "Phone 2 Type",
      "Phone 3",
      "Phone 3 Type",
      "City",
      "State",
      "Zip",
    ],
    exampleRows: [
      {
        Address: "123 Main St",
        "Phone 1": "8165550100",
        "Phone 1 Type": "Mobile",
        "Phone 2": "8165550101",
        "Phone 2 Type": "Landline",
      },
      {
        Address: "456 Oak Ave",
        "Phone 1": "(816) 555-0200",
        "Phone 1 Type": "Mobile",
      },
    ],

    async apply(ctx, args, options) {
      const { rowIndex, parsedRow, property } = args;
      const address = parsedRow.Address ?? "";
      const contactId = property[contactKey] as string | null;

      if (!contactId) {
        return {
          kind: "rejected",
          rowIndex,
          address,
          reason: noContactReason,
          detail: `Property has no ${role} contact attached.`,
        };
      }

      const slots: Array<"phone_1" | "phone_2" | "phone_3"> = [
        "phone_1",
        "phone_2",
        "phone_3",
      ];
      const headerNames = ["Phone 1", "Phone 2", "Phone 3"];
      const typeHeaderNames = ["Phone 1 Type", "Phone 2 Type", "Phone 3 Type"];
      // Hard rule (migration 080): every written phone needs its line
      // type in the same update — both so the trigger accepts the write
      // and so a new number can't ride on the previous number's type.
      const update: Partial<
        Record<
          | (typeof slots)[number]
          | "phone_1_type"
          | "phone_2_type"
          | "phone_3_type",
          string
        >
      > = {};
      let anyValid = false;

      for (let i = 0; i < slots.length; i++) {
        const raw = (parsedRow[headerNames[i]] ?? "").trim();
        if (!raw) continue;
        const normalized = normalizePhone(raw);
        if (!normalized) {
          return {
            kind: "rejected",
            rowIndex,
            address,
            reason: "invalid-phone",
            detail: `"${raw}" in column "${headerNames[i]}" is not a valid US phone (need 10 digits or 11 with leading 1).`,
          };
        }
        const lineType = lineTypeFromVendorLabel(
          (parsedRow[typeHeaderNames[i]] ?? "").trim(),
        );
        if (lineType === "unknown") {
          return {
            kind: "rejected",
            rowIndex,
            address,
            reason: "missing-line-type",
            detail: `"${headerNames[i]}" has a number but "${typeHeaderNames[i]}" is missing or not Mobile/Landline — numbers without a line type are never saved.`,
          };
        }
        update[slots[i]] = normalized;
        update[`${slots[i]}_type` as const] = lineType;
        anyValid = true;
      }

      if (!anyValid) {
        return { kind: "unchanged", rowIndex, address, reason: "blank" };
      }

      if (!options.dryRun) {
        const { error } = await ctx.supabase
          .from("contacts")
          .update(update)
          .eq("id", contactId);
        if (error) {
          return {
            kind: "rejected",
            rowIndex,
            address,
            reason: "db-error",
            detail: error.message,
          };
        }
      }
      return {
        kind: "updated",
        rowIndex,
        address,
        before: { contact_id: contactId },
        after: update,
      };
    },
  };
}
