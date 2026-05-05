import crypto from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import type { Database } from "@/lib/supabase/types";

import { pickFromPool } from "./pool";

type Row = { id: string; content: string };

function makeClient(rows: Row[] | null, error: unknown = null) {
  const chain: Record<string, unknown> = {};
  chain.order = () => Promise.resolve({ data: rows, error });
  chain.is = () => chain;
  chain.eq = () => chain;
  chain.select = () => chain;
  return {
    from: () => chain,
  } as unknown as SupabaseClient<Database>;
}

const ORG = "org-1";
const CAT = "Opener - Homeowner";

describe("pickFromPool", () => {
  it("returns null on db error", async () => {
    const client = makeClient(null, new Error("db failure"));
    expect(await pickFromPool(client, ORG, CAT, "any-seed")).toBeNull();
  });

  it("returns null when data is null (no rows returned)", async () => {
    const client = makeClient(null);
    expect(await pickFromPool(client, ORG, CAT, "any-seed")).toBeNull();
  });

  it("returns null when the pool is empty", async () => {
    const client = makeClient([]);
    expect(await pickFromPool(client, ORG, CAT, "any-seed")).toBeNull();
  });

  it("single-item pool: any seed returns that one template", async () => {
    const pool: Row[] = [{ id: "t1", content: "Hello there" }];
    const client = makeClient(pool);
    for (const seed of ["a", "b", "enr-123", "uuid-xyz"]) {
      const result = await pickFromPool(client, ORG, CAT, seed);
      expect(result).toEqual(pool[0]);
    }
  });

  it("same seed always returns the same template (determinism)", async () => {
    const pool: Row[] = [
      { id: "t1", content: "Template 1" },
      { id: "t2", content: "Template 2" },
      { id: "t3", content: "Template 3" },
    ];
    const client = makeClient(pool);
    const a = await pickFromPool(client, ORG, CAT, "enr-stable");
    const b = await pickFromPool(client, ORG, CAT, "enr-stable");
    expect(a).toEqual(b);
    expect(a).not.toBeNull();
  });

  it("index is SHA-256 uint32BE mod pool size (exact match for known seed)", async () => {
    // seed "enr-abc" with pool size 4 → index 0  (pre-computed above)
    // seed "enr-1"   with pool size 4 → index 2  (pre-computed above)
    const pool: Row[] = [
      { id: "t1", content: "A" },
      { id: "t2", content: "B" },
      { id: "t3", content: "C" },
      { id: "t4", content: "D" },
    ];
    const client1 = makeClient(pool);
    const client2 = makeClient(pool);

    function expectedIndex(seed: string, size: number) {
      const hash = crypto.createHash("sha256").update(seed).digest();
      return hash.readUInt32BE(0) % size;
    }

    const r1 = await pickFromPool(client1, ORG, CAT, "enr-abc");
    expect(r1).toEqual(pool[expectedIndex("enr-abc", 4)]); // index 0 → t1

    const r2 = await pickFromPool(client2, ORG, CAT, "enr-1");
    expect(r2).toEqual(pool[expectedIndex("enr-1", 4)]); // index 2 → t3
  });

  it("different seeds distribute across all templates in the pool", async () => {
    const pool: Row[] = [
      { id: "t1", content: "A" },
      { id: "t2", content: "B" },
      { id: "t3", content: "C" },
      { id: "t4", content: "D" },
    ];
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const client = makeClient(pool);
      const result = await pickFromPool(client, ORG, CAT, `seed-${i}`);
      if (result) seen.add(result.id);
    }
    // All 4 templates should be selected across 100 distinct seeds
    expect(seen.size).toBe(pool.length);
  });

  it("two-template pool: both templates appear across many seeds", async () => {
    const pool: Row[] = [
      { id: "t1", content: "Variant A" },
      { id: "t2", content: "Variant B" },
    ];
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const client = makeClient(pool);
      const result = await pickFromPool(client, ORG, CAT, `enr-${i}`);
      if (result) seen.add(result.id);
    }
    expect(seen).toContain("t1");
    expect(seen).toContain("t2");
  });
});
