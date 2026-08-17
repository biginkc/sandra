import {
  isDoNotCallLabel,
  lineTypeFromVendorLabel,
} from "@/lib/messaging/line-type";
import type { Database } from "@/lib/supabase/types";

import { normalizePhone } from "../normalize";

import type { SubOperationModule } from "./types";

type ContactPhoneUpdate = Pick<
  Database["public"]["Tables"]["contacts"]["Update"],
  | "phone_1"
  | "phone_1_type"
  | "phone_2"
  | "phone_2_type"
  | "phone_3"
  | "phone_3_type"
  | "do_not_contact"
>;

type Role = "homeowner" | "agent";

export function buildPhonesOp(role: Role): SubOperationModule {
  const idSuffix = role === "homeowner" ? "homeowner-phones" : "agent-phones";
  const label =
    role === "homeowner"
      ? "Update homeowner phone numbers"
      : "Update agent phone numbers";
  const noContactReason = role === "homeowner" ? "no-homeowner" : "no-agent";
  const contactKey =
    role === "homeowner" ? "homeowner_contact_id" : "agent_contact_id";

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
      const update: Partial<ContactPhoneUpdate> = {};
      let anyValid = false;
      let dncFlagged = false;

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
        const typeRaw = (parsedRow[typeHeaderNames[i]] ?? "").trim();
        const lineType = lineTypeFromVendorLabel(typeRaw);
        if (lineType === "unknown") {
          if (isDoNotCallLabel(typeRaw)) {
            // Drop-but-flag, same as the CSV-import DNC path: the number
            // itself is never saved to this slot (no do_not_call line
            // type exists), but the compliance signal must survive as a
            // contact-level flag so this update can't silently leave a
            // suppressed number's contact callable (Codex PR #310
            // finding 5). One-way — only ever set true below.
            dncFlagged = true;
            continue;
          }
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

      if (dncFlagged) {
        update.do_not_contact = true;
        anyValid = true;
      }

      if (!anyValid) {
        return { kind: "unchanged", rowIndex, address, reason: "blank" };
      }

      const dncLockedResult = {
        kind: "rejected" as const,
        rowIndex,
        address,
        reason: "dnc-locked",
        detail: "Permanent Do Not Contact records are read-only.",
      };
      if (property.is_dnc_locked && !dncFlagged) {
        return dncLockedResult;
      }

      const { data: currentContact, error: contactReadError } =
        await ctx.supabase
          .from("contacts")
          .select("do_not_contact")
          .eq("id", contactId)
          .eq("org_id", property.org_id)
          .maybeSingle();
      if (contactReadError) {
        return {
          kind: "rejected",
          rowIndex,
          address,
          reason: "db-error",
          detail: contactReadError.message,
        };
      }
      if (!currentContact) {
        return {
          kind: "rejected",
          rowIndex,
          address,
          reason: noContactReason,
          detail: `Property has no ${role} contact attached.`,
        };
      }
      if (currentContact.do_not_contact && !dncFlagged) {
        return dncLockedResult;
      }
      if (currentContact.do_not_contact && dncFlagged) {
        return { kind: "unchanged", rowIndex, address, reason: "no-change" };
      }

      // Permanent DNC must be a flag-only transition. A row that also
      // contains clean phones cannot smuggle those mutable fields into the
      // same write, and a repeated DNC row is an idempotent no-op.
      const writeUpdate: Partial<ContactPhoneUpdate> = dncFlagged
        ? { do_not_contact: true }
        : update;

      if (!options.dryRun && dncFlagged) {
        const { data: ratcheted, error } = await ctx.supabase
          .from("contacts")
          .update(writeUpdate)
          .eq("id", contactId)
          .eq("org_id", property.org_id)
          .eq("do_not_contact", false)
          .select("id");
        if (!error && ratcheted?.length === 1) {
          // Positive proof: exactly the intended contact was ratcheted.
        } else {
          if (!error && ratcheted && ratcheted.length > 1) {
            return {
              kind: "rejected",
              rowIndex,
              address,
              reason: "db-error",
              detail: `DNC ratchet updated ${ratcheted.length} contacts; expected exactly one.`,
            };
          }
          if (error && !error.message.includes("DNC_LOCKED")) {
            return {
              kind: "rejected",
              rowIndex,
              address,
              reason: "db-error",
              detail: error.message,
            };
          }

          // Zero rows can be an idempotent race (another writer already
          // ratcheted DNC), or a concurrent delete/stale contact. Re-read and
          // accept only positive proof that this exact contact is now DNC.
          const { data: proof, error: proofError } = await ctx.supabase
            .from("contacts")
            .select("do_not_contact")
            .eq("id", contactId)
            .eq("org_id", property.org_id)
            .maybeSingle();
          if (proofError) {
            return {
              kind: "rejected",
              rowIndex,
              address,
              reason: "db-error",
              detail: `DNC ratchet proof failed: ${proofError.message}`,
            };
          }
          if (!proof) {
            return {
              kind: "rejected",
              rowIndex,
              address,
              reason: "db-error",
              detail:
                "DNC ratchet was not confirmed because the contact no longer exists.",
            };
          }
          if (!proof.do_not_contact) {
            return {
              kind: "rejected",
              rowIndex,
              address,
              reason: "db-error",
              detail:
                "DNC ratchet updated zero rows and the contact remains callable.",
            };
          }
        }
      } else if (!options.dryRun) {
        const { error } = await ctx.supabase
          .from("contacts")
          .update(writeUpdate)
          .eq("id", contactId)
          .eq("org_id", property.org_id);
        if (error) {
          if (error.message.includes("DNC_LOCKED")) return dncLockedResult;
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
        after: writeUpdate,
      };
    },
  };
}
