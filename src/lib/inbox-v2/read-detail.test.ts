import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { readInboxDetail } from "./read-detail";
import { validateInboxReadRequest } from "./read-contract";

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), context: vi.fn() }));
vi.mock("@/lib/messages/threading", () => ({ resolveSmsConversationOrg: mocks.resolve }));
vi.mock("@/app/(dashboard)/messages/inbox-detail-data", () => ({ fetchInboxDetail: mocks.context }));
const conversationId = "123e4567-e89b-12d3-a456-426614174000";
const orgId = "123e4567-e89b-12d3-a456-426614174099";
const stamp = "2026-09-13T10:00:00.123456Z";
const rows = [3, 2, 1].map(n => ({ id: `123e4567-e89b-12d3-a456-42661417400${n}`, created_at: stamp, body: `message ${n}`, direction: "inbound" }));

function fixture(fail = false) {
  const calls: Array<{ columns: string; filters: Array<[string, unknown]>; orders: string[]; limit: number; expression?: string }> = [];
  const from = vi.fn(() => ({ select(columns: string) {
    const call = { columns, filters: [] as Array<[string, unknown]>, orders: [] as string[], limit: 0, expression: undefined as string | undefined };
    calls.push(call);
    const query = {
      eq(key: string, value: unknown) { call.filters.push([key, value]); return query; },
      order(key: string, opts: { ascending: boolean }) { call.orders.push(`${key}:${opts.ascending}`); return query; },
      limit(n: number) { call.limit = n; return query; },
      or(expression: string) { call.expression = expression; return query; },
      then(resolve: (value: unknown) => unknown) {
        const beforeId = call.expression?.match(/id\.lt\.([0-9a-f-]+)/)?.[1];
        const matching = beforeId ? rows.filter(row => row.id < beforeId) : rows;
        return Promise.resolve(resolve({ data: matching.slice(0, call.limit), error: fail ? { message: "secret database detail" } : null }));
      },
    };
    return query;
  } }));
  return { client: { from } as unknown as SupabaseClient<Database>, from, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolve.mockResolvedValue(orgId);
  mocks.context.mockResolvedValue({ conversationId, threadId: conversationId, contactId: "contact",
    initialMessages: [{ body: "broad legacy payload must not escape", metadata: { private: true } }] });
});

describe("independent Inbox detail read", () => {
  it("does not query history or context for a foreign or inaccessible conversation", async () => {
    for (const resolved of [null, "foreign-org"]) {
      mocks.resolve.mockResolvedValue(resolved);
      const f = fixture();
      expect(await readInboxDetail(f.client, orgId, { conversationId, pageSize: 2, before: null })).toEqual({ status: "unavailable", conversationId });
      expect(f.from).not.toHaveBeenCalled();
      expect(mocks.context).not.toHaveBeenCalled();
    }
  });

  it("pages tied timestamps without repeats or losing the final item", async () => {
    const f = fixture();
    const first = await readInboxDetail(f.client, orgId, { conversationId, pageSize: 2, before: null });
    expect(first.status).toBe("ready");
    if (first.status !== "ready") throw new Error("Expected page");
    expect(first.messages.map(row => row.id)).toEqual([rows[1].id, rows[0].id]);
    expect(first.context).not.toHaveProperty("initialMessages");
    expect(first.freshness.latestInbound).toEqual({ id: rows[0].id, createdAt: stamp });
    const next = validateInboxReadRequest({ conversationId, pageSize: 2, cursor: first.nextCursor });
    if (!next.ok) throw new Error("Expected valid cursor");
    expect(next.value.before).toEqual({ createdAt: stamp, id: rows[1].id });
    const second = await readInboxDetail(f.client, orgId, next.value);
    if (second.status !== "ready") throw new Error("Expected older page");
    expect(second.messages.map(row => row.id)).toEqual([rows[2].id]);
    expect(second.nextCursor).toBeNull();
    expect(f.calls[2].expression).toBe(`created_at.lt."${stamp}",and(created_at.eq."${stamp}",id.lt.${rows[1].id})`);
    for (const call of f.calls) {
      expect(call.filters).toContainEqual(["org_id", orgId]);
      expect(call.filters).toContainEqual(["conversation_id", conversationId]);
      expect(call.orders).toEqual(["created_at:false", "id:false"]);
      expect(call.columns).not.toContain("*");
      expect(call.columns).not.toContain("metadata");
    }
    expect(f.calls[0].limit).toBe(3);
  });

  it("rejects raw filter injection even from a typed internal caller before reads", async () => {
    const f = fixture();
    await expect(readInboxDetail(f.client, orgId, { conversationId, pageSize: 2, before: { id: rows[0].id, createdAt: `${stamp}),id.gt.x` } })).rejects.toThrow("Invalid history cursor position");
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(f.from).not.toHaveBeenCalled();
  });

  it("fails closed for query errors and context identity mismatches", async () => {
    await expect(readInboxDetail(fixture(true).client, orgId, { conversationId, pageSize: 2, before: null })).rejects.toThrow("Inbox detail unavailable");
    mocks.context.mockResolvedValue({ conversationId: "wrong", threadId: "wrong" });
    await expect(readInboxDetail(fixture().client, orgId, { conversationId, pageSize: 2, before: null })).rejects.toThrow("Inbox detail identity mismatch");
  });
});
