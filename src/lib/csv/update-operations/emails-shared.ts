import type { SubOperationModule } from "./types";

type Role = "homeowner" | "agent";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function buildEmailsOp(role: Role): SubOperationModule {
  const idSuffix = role === "homeowner" ? "homeowner-emails" : "agent-emails";
  const label = role === "homeowner"
    ? "Update homeowner emails"
    : "Update agent emails";
  const noContactReason = role === "homeowner" ? "no-homeowner" : "no-agent";
  const contactKey = role === "homeowner"
    ? "homeowner_contact_id"
    : "agent_contact_id";

  return {
    id: `update-${idSuffix}` as SubOperationModule["id"],
    label,
    description: `Overwrite the ${role}'s email. Trimmed + lowercased before save.`,
    requiredColumns: ["Address", "Email"],
    optionalColumns: ["City", "State", "Zip"],
    exampleRows: [
      { Address: "123 Main St", Email: "owner@example.com" },
      { Address: "456 Oak Ave", Email: "jane.doe@gmail.com" },
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
      const raw = (parsedRow.Email ?? "").trim();
      if (!raw) {
        return { kind: "unchanged", rowIndex, address, reason: "blank" };
      }
      const lowered = raw.toLowerCase();
      if (!EMAIL_RE.test(lowered)) {
        return {
          kind: "rejected",
          rowIndex,
          address,
          reason: "invalid-email",
          detail: `"${raw}" doesn't look like an email.`,
        };
      }
      if (!options.dryRun) {
        const { error } = await ctx.supabase
          .from("contacts")
          .update({ email: lowered })
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
        after: { email: lowered },
      };
    },
  };
}
