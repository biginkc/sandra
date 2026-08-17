import type { SubOperationModule } from "./types";

const VALID = ["hot", "warm", "cold"] as const;
type MotivationValue = (typeof VALID)[number];

function normalize(raw: string): MotivationValue | null {
  const canon = raw.trim().toLowerCase();
  return (VALID as readonly string[]).includes(canon)
    ? (canon as MotivationValue)
    : null;
}

export const updateMotivationLevelOp: SubOperationModule = {
  id: "update-motivation-level",
  label: "Update motivation level",
  description:
    "Set how motivated the seller is. Hot / warm / cold, or blank to clear.",
  requiredColumns: ["Address", "Motivation"],
  optionalColumns: ["City", "State", "Zip"],
  exampleRows: [
    { Address: "123 Main St", Motivation: "hot" },
    { Address: "456 Oak Ave", Motivation: "warm" },
    { Address: "789 Pine Rd", Motivation: "" },
  ],

  async apply(ctx, args, options) {
    const { rowIndex, parsedRow, property } = args;
    const address = parsedRow.Address ?? "";
    const raw = (parsedRow.Motivation ?? "").trim();

    let next: MotivationValue | null;
    if (!raw) {
      next = null;
    } else {
      const candidate = normalize(raw);
      if (!candidate) {
        return {
          kind: "rejected",
          rowIndex,
          address,
          reason: "invalid-motivation",
          detail: `"${raw}" is not one of: hot, warm, cold (or blank to clear)`,
        };
      }
      next = candidate;
    }

    if (next === property.motivation_level) {
      return { kind: "unchanged", rowIndex, address, reason: "no-change" };
    }
    if (!options.dryRun) {
      const { data, error } = await ctx.supabase
        .from("properties")
        .update({ motivation_level: next })
        .eq("id", property.id)
        .eq("org_id", property.org_id)
        .is("deleted_at", null)
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
          reason: "stale-property",
          detail:
            "The matched property was deleted or no longer belongs to this organization before the update saved.",
        };
      }
    }
    return {
      kind: "updated",
      rowIndex,
      address,
      before: { motivation_level: property.motivation_level },
      after: { motivation_level: next },
    };
  },
};
