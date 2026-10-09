import { describe, expect, it } from "vitest";

import { APPROVED_REPLY_CATEGORY, APPROVED_REPLY_NAMES, APPROVED_REPLY_TEXTS } from "./approved-reply-texts";
import { seedApprovedReplyTemplates } from "./seed-reply-templates";

type Row = { org_id: string; name: string; content: string; category: string; deleted_at: string | null };

function fakeLibrary(rows: Row[], opts: { insertError?: string; lookupError?: string } = {}) {
  const inserted: Array<Record<string, unknown>> = [];
  const client = {
    from(table: string) {
      expect(table).toBe("sms_templates");
      const filters: Record<string, unknown> = {};
      let contentIn: string[] | null = null;
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          filters[col] = val;
          return builder;
        },
        is: (col: string, val: unknown) => {
          filters[col] = val;
          return builder;
        },
        in: (_col: string, vals: string[]) => {
          contentIn = vals;
          return builder;
        },
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve(
            opts.lookupError
              ? { data: null, error: { message: opts.lookupError } }
              : {
                  data: rows.filter(
                    (r) => r.org_id === filters.org_id && r.deleted_at === null && (contentIn ?? []).includes(r.content),
                  ),
                  error: null,
                },
          ).then(resolve),
        insert: async (row: Record<string, unknown>) => {
          if (opts.insertError) return { error: { message: opts.insertError } };
          inserted.push(row);
          rows.push({ ...(row as Row), deleted_at: null });
          return { error: null };
        },
      };
      return builder;
    },
  };
  return { client: client as never, inserted };
}

describe("seedApprovedReplyTemplates", () => {
  it("inserts all four approved texts, unapproved, with the approval note and no mappings", async () => {
    const lib = fakeLibrary([]);
    const result = await seedApprovedReplyTemplates(lib.client, "org-1");
    expect(result.created.sort()).toEqual(["hostile", "not_interested", "nurture", "wrong_number"]);
    expect(result.alreadyPresent).toEqual([]);
    expect(lib.inserted).toHaveLength(4);
    for (const row of lib.inserted) {
      expect(Object.keys(row).sort()).toEqual(["category", "content", "name", "org_id"]); // never an approval column
      expect(row.org_id).toBe("org-1");
      expect(row.category).toBe(APPROVED_REPLY_CATEGORY);
    }
    expect(lib.inserted.map((r) => r.content).sort()).toEqual(Object.values(APPROVED_REPLY_TEXTS).sort());
    expect(lib.inserted.map((r) => r.name).sort()).toEqual(Object.values(APPROVED_REPLY_NAMES).sort());
  });

  it("is idempotent: a second run inserts nothing", async () => {
    const lib = fakeLibrary([]);
    await seedApprovedReplyTemplates(lib.client, "org-1");
    const again = await seedApprovedReplyTemplates(lib.client, "org-1");
    expect(again.created).toEqual([]);
    expect(again.alreadyPresent.sort()).toEqual(["hostile", "not_interested", "nurture", "wrong_number"]);
    expect(lib.inserted).toHaveLength(4);
  });

  it("skips a text an owner already created by hand and only fills the gap", async () => {
    const lib = fakeLibrary([
      { org_id: "org-1", name: "mine", content: APPROVED_REPLY_TEXTS.nurture, category: "General", deleted_at: null },
      { org_id: "org-1", name: "deleted", content: APPROVED_REPLY_TEXTS.hostile, category: "General", deleted_at: "2026-10-01" },
      { org_id: "org-2", name: "other org", content: APPROVED_REPLY_TEXTS.wrong_number, category: "General", deleted_at: null },
    ]);
    const result = await seedApprovedReplyTemplates(lib.client, "org-1");
    expect(result.alreadyPresent).toEqual(["nurture"]);
    expect(result.created.sort()).toEqual(["hostile", "not_interested", "wrong_number"]);
  });

  it("dry run reports but writes nothing", async () => {
    const lib = fakeLibrary([]);
    const result = await seedApprovedReplyTemplates(lib.client, "org-1", { dryRun: true });
    expect(result.created).toHaveLength(4);
    expect(lib.inserted).toEqual([]);
  });

  it("surfaces lookup and insert errors", async () => {
    await expect(seedApprovedReplyTemplates(fakeLibrary([], { lookupError: "boom" }).client, "o")).rejects.toThrow(/boom/);
    await expect(seedApprovedReplyTemplates(fakeLibrary([], { insertError: "nope" }).client, "o")).rejects.toThrow(/nope/);
  });
});
