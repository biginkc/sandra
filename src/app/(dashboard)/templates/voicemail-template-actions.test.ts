import { beforeEach, describe, expect, it, vi } from "vitest";

type Call = { table: string; op: string; payload?: unknown; filters: Array<[string, string, unknown]> };

const mocks = vi.hoisted(() => ({
  calls: [] as Call[],
  rows: [] as Array<Record<string, unknown>>,
  current: { category: "Group A" } as { category: string } | null,
  siblings: 2,
  steps: 0,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from: (table: string) => {
      const call: Call = { table, op: "select", filters: [] };
      mocks.calls.push(call);
      const chain: Record<string, unknown> = {};
      const filter = (name: string) => (col: string, val: unknown) => { call.filters.push([name, col, val]); return chain; };
      chain.select = (_c?: string, opts?: { head?: boolean }) => { if (opts?.head) call.op = "count"; return chain; };
      chain.insert = (payload: unknown) => { call.op = "insert"; call.payload = payload; return chain; };
      chain.update = (payload: unknown) => { call.op = "update"; call.payload = payload; return chain; };
      for (const n of ["eq", "is", "order", "limit"]) chain[n] = filter(n);
      chain.maybeSingle = async () => ({
        data: table === "organizations" ? { id: "org-1" } : mocks.current,
        error: null,
      });
      chain.single = async () => ({ data: { id: "vt-new" }, error: null });
      chain.then = (resolve: (v: unknown) => unknown) => {
        if (call.op === "count") {
          return Promise.resolve({ count: table === "sequence_steps" ? mocks.steps : mocks.siblings, error: null }).then(resolve);
        }
        if (call.op === "update") return Promise.resolve({ error: null, count: 1 }).then(resolve);
        return Promise.resolve({ data: mocks.rows, error: null }).then(resolve);
      };
      return chain;
    },
  }),
}));

import {
  createVoicemailTemplate,
  deleteVoicemailTemplate,
  listVoicemailTemplateGroups,
  listVoicemailTemplates,
  updateVoicemailTemplate,
} from "./voicemail-template-actions";

beforeEach(() => {
  mocks.calls = [];
  mocks.rows = [];
  mocks.current = { category: "Group A" };
  mocks.siblings = 2;
  mocks.steps = 0;
});

const tables = () => [...new Set(mocks.calls.map((c) => c.table))];

describe("voicemail template actions", () => {
  it("lists from voicemail_templates only, never sms_templates", async () => {
    mocks.rows = [{ id: "vt-1", name: "A", content: "Hi", category: "Group A" }];
    const result = await listVoicemailTemplates();
    expect(result).toEqual({ ok: true, data: mocks.rows });
    expect(tables()).toEqual(["voicemail_templates"]);
  });

  it("groups scripts and counts the ones the worker would refuse", async () => {
    mocks.rows = [
      { id: "1", name: "a", content: "Hi {{first_name}}", category: "Group B" },
      { id: "2", name: "b", content: "[Hi/Hello]", category: "Group A" },
      { id: "3", name: "c", content: "Hello", category: "Group A" },
    ];
    expect(await listVoicemailTemplateGroups()).toEqual({
      ok: true,
      data: [
        { category: "Group A", count: 2, problemCount: 1 },
        { category: "Group B", count: 1, problemCount: 0 },
      ],
    });
  });

  it("creates a trimmed script in voicemail_templates", async () => {
    const result = await createVoicemailTemplate({ name: " Name ", category: " Group A ", content: " Hi {{first_name}} " });
    expect(result).toEqual({ ok: true, data: { id: "vt-new" } });
    const insert = mocks.calls.find((c) => c.op === "insert")!;
    expect(insert.table).toBe("voicemail_templates");
    expect(insert.payload).toEqual({ org_id: "org-1", name: "Name", category: "Group A", content: "Hi {{first_name}}", created_by: "user-1" });
    expect(tables()).not.toContain("sms_templates");
  });

  it.each([
    ["over 1,200 characters", "a".repeat(1201), /1,200/],
    ["single braces", "Hi {first_name}", /double braces/],
    ["random-variant brackets", "[Hi/Hello] there", /\[this\/that\]/],
    ["empty", "  ", /Write the script/],
  ])("refuses a script that is %s", async (_label, content, message) => {
    const result = await createVoicemailTemplate({ name: "n", category: "g", content });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(message);
    expect(mocks.calls).toHaveLength(0);
  });

  it("requires a group", async () => {
    const result = await createVoicemailTemplate({ name: "n", category: " ", content: "Hi" });
    expect(result.ok).toBe(false);
  });

  it("refuses to delete the last script of a group a drip step rotates through", async () => {
    mocks.siblings = 1;
    mocks.steps = 2;
    const result = await deleteVoicemailTemplate("vt-1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VM_TPL_IN_USE");
    expect(mocks.calls.some((c) => c.op === "update")).toBe(false);
  });

  it("soft-deletes when other scripts remain in the group", async () => {
    mocks.siblings = 2;
    mocks.steps = 2;
    expect(await deleteVoicemailTemplate("vt-1")).toEqual({ ok: true, data: null });
    const update = mocks.calls.find((c) => c.op === "update")!;
    expect(update.table).toBe("voicemail_templates");
    expect(update.payload).toEqual({ deleted_at: expect.any(String) });
  });

  it("refuses moving the last script out of a used group, allows editing its text", async () => {
    mocks.siblings = 1;
    mocks.steps = 1;
    const moved = await updateVoicemailTemplate("vt-1", { category: "Group B" });
    expect(moved.ok).toBe(false);
    expect(await updateVoicemailTemplate("vt-1", { content: "New text" })).toEqual({ ok: true, data: null });
  });
});
