import type { SubOperationModule } from "./types";

function splitTags(raw: string): string[] {
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

export const tagExistingPropertiesOp: SubOperationModule = {
  id: "tag-existing-properties",
  label: "Tag existing properties",
  description:
    "Apply existing tags to properties. Unknown tag names are surfaced for an admin to create — the importer never auto-creates tags.",
  requiredColumns: ["Address", "Tags"],
  optionalColumns: ["City", "State", "Zip"],
  exampleRows: [
    { Address: "123 Main St", Tags: "hot, probate" },
    { Address: "456 Oak Ave", Tags: "absentee" },
    { Address: "789 Pine Rd", Tags: "vacant, code-violation" },
  ],

  async apply(ctx, args, options) {
    const { rowIndex, parsedRow, property } = args;
    const address = parsedRow.Address ?? "";
    const raw = (parsedRow.Tags ?? "").trim();

    if (!raw) {
      return { kind: "unchanged", rowIndex, address, reason: "blank" };
    }
    const requested = splitTags(raw);
    if (requested.length === 0) {
      return { kind: "unchanged", rowIndex, address, reason: "blank" };
    }

    // Case-insensitive lookup against the existing tags catalog. We do
    // NOT auto-create — admins control tag creation via the /leads UI.
    const lowercased = requested.map((t) => t.toLowerCase());
    const { data: tagRows, error: lookupErr } = await ctx.supabase
      .from("tags")
      .select("id, name");
    if (lookupErr) {
      return {
        kind: "rejected",
        rowIndex,
        address,
        reason: "db-error",
        detail: lookupErr.message,
      };
    }
    const byLowerName = new Map(
      (tagRows ?? []).map((r) => [r.name.toLowerCase(), r.id]),
    );

    const resolved = new Map<string, { id: string; label: string }>();
    const missing: string[] = [];
    for (const wanted of requested) {
      const id = byLowerName.get(wanted.toLowerCase());
      if (id) {
        const row = (tagRows ?? []).find((tag) => tag.id === id);
        if (row) resolved.set(id, { id, label: row.name });
      } else missing.push(wanted.toLowerCase());
    }

    if (missing.length > 0) {
      // All-or-nothing: if ANY tag in the row is unknown, skip the whole
      // row. The admin creates the missing tag(s), then re-runs the upload
      // — that way no half-applied state and no double-write of the
      // already-existing tag(s).
      return {
        kind: "rejected",
        rowIndex,
        address,
        reason: "unknown-tag",
        detail: `Unknown tag(s): ${missing.join(", ")}`,
        unknownTags: Array.from(new Set(missing)),
      };
    }

    void lowercased; // keep eslint happy if it complains; the var documents intent

    if (!options.dryRun) {
      const upsertRows = [...resolved.values()].map((tag) => ({
        property_id: property.id,
        tag_id: tag.id,
        source: "import",
        applied_by: ctx.userId,
      }));
      const { data: inserted, error: upsertErr } = await ctx.supabase
        .from("property_tags")
        .upsert(upsertRows, {
          onConflict: "property_id,tag_id",
          ignoreDuplicates: true,
        })
        .select("tag_id");
      if (upsertErr) {
        return {
          kind: "rejected",
          rowIndex,
          address,
          reason: "db-error",
          detail: upsertErr.message,
        };
      }
      const insertedIds = new Set((inserted ?? []).map((row) => row.tag_id));
      if (insertedIds.size === 0) {
        return { kind: "unchanged", rowIndex, address, reason: "no-change" };
      }
      return {
        kind: "updated",
        rowIndex,
        address,
        before: {},
        after: {
          tags: [...resolved.values()].filter((tag) => insertedIds.has(tag.id)),
        },
      };
    }

    return {
      kind: "updated",
      rowIndex,
      address,
      before: {},
      after: { tags: requested },
    };
  },
};
