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
    description: `Overwrite the ${role}'s phone slots in order. Blank slots are left untouched.`,
    requiredColumns: ["Address", "Phone 1"],
    optionalColumns: ["Phone 2", "Phone 3", "City", "State", "Zip"],
    exampleRows: [
      {
        Address: "123 Main St",
        "Phone 1": "8165550100",
        "Phone 2": "8165550101",
      },
      { Address: "456 Oak Ave", "Phone 1": "(816) 555-0200" },
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
      const update: Partial<Record<(typeof slots)[number], string>> = {};
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
        update[slots[i]] = normalized;
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
