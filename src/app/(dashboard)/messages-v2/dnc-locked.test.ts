import { describe, expect, it } from "vitest";

import { withoutDncLocked } from "./dnc-locked";
import type { LooseSupabase } from "./queries";
import type { OpenHold, RunWithSteps } from "./types";

const hold = (id: string, property_id: string | null = id): OpenHold<RunWithSteps> => ({
  id, property_id, conversation_id: null, sources: ["needs_attention"], since: null, reason: "r", run: null,
});

function client(locked: string[], error: unknown = null): LooseSupabase {
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.eq = () => q;
  q.in = async (_c: string, ids: string[]) => ({ data: error ? null : ids.filter((i) => locked.includes(i)).map((id) => ({ id })), error });
  return { from: () => q, rpc: () => q } as unknown as LooseSupabase;
}

describe("withoutDncLocked", () => {
  it("drops holds on permanently do-not-contact locked properties and keeps the rest", async () => {
    const out = await withoutDncLocked(client(["b"]), "org", [hold("a"), hold("b"), hold("c")]);
    expect(out?.map((h) => h.id)).toEqual(["a", "c"]);
  });
  it("keeps holds with no property (nothing to look up)", async () => {
    const out = await withoutDncLocked(client(["a"]), "org", [hold("x", null)]);
    expect(out).toHaveLength(1);
  });
  it("FAILS CLOSED when the lookup fails: null, so the caller renders an error and no cards", async () => {
    const out = await withoutDncLocked(client(["a"], { message: "boom" }), "org", [hold("a"), hold("b")]);
    expect(out).toBeNull();
  });
});
