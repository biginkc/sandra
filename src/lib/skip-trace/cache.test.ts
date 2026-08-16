import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import type { Database } from "@/lib/supabase/types";

import {
  normalizeAddress,
  readCache,
  readCacheMany,
  writeCache,
} from "./cache";

const unskipTracedMigration = readFileSync(
  path.resolve(
    process.cwd(),
    "supabase/migrations/20260804130000_leads_unskip_traced_view.sql",
  ),
  "utf8",
);
const cacheSource = readFileSync(
  path.resolve(process.cwd(), "src/lib/skip-trace/cache.ts"),
  "utf8",
);

describe("normalizeAddress", () => {
  it("scopes every cache read and write to the authoritative organization", () => {
    expect(cacheSource.match(/\.eq\("org_id", orgId\)/g)).toHaveLength(2);
    expect(cacheSource).toContain("org_id: orgId");
    expect(cacheSource).toContain(
      'onConflict: "org_id,provider,address_normalized"',
    );
  });
  it("lowercases and joins with pipe", () => {
    expect(
      normalizeAddress({
        address: "123 Main St",
        city: "Kansas City",
        state: "MO",
        zip: "64106",
      }),
    ).toBe("123 main st|kansas city|mo|64106");
  });

  it("skips null/undefined parts", () => {
    expect(
      normalizeAddress({
        address: "123 Main St",
        city: null,
        state: "MO",
        zip: undefined,
      }),
    ).toBe("123 main st|mo");
  });

  it("keeps SQL and TypeScript keys equivalent for every blank-value case", () => {
    const cases = [
      { label: "null", value: null as string | null | undefined },
      { label: "undefined", value: undefined },
      { label: "empty", value: "" },
      { label: "whitespace-only", value: "   " },
      { label: "normal", value: " Kansas City " },
    ];

    // This is the SQL expression's contract: filter raw NULL/empty values
    // before trim (the same order as cache.ts), then join the survivors.
    const sqlEquivalent = (value: string | null | undefined): string =>
      ["123 main st", value, "mo", "64106"]
        .filter(
          (component): component is string =>
            component !== null && component !== undefined && component !== "",
        )
        .map((component) => component.trim().toLowerCase())
        .join("|");

    for (const { label, value } of cases) {
      const tsKey = normalizeAddress({
        address: "123 Main St",
        city: value,
        state: "MO",
        zip: "64106",
      });
      expect(tsKey, label).toBe(sqlEquivalent(value));
    }

    expect(unskipTracedMigration).toContain(
      "from unnest(array[b.address, b.city, b.state, b.zip])",
    );
    expect(unskipTracedMigration).toContain("component <> ''");
    expect(unskipTracedMigration).not.toContain("concat_ws(");
  });

  it("trims whitespace before lowercasing", () => {
    expect(
      normalizeAddress({
        address: "  456 Oak Ave  ",
        city: " St Louis ",
        state: " MO ",
      }),
    ).toBe("456 oak ave|st louis|mo");
  });

  it("two equivalent addresses with different formatting normalize the same", () => {
    const a = normalizeAddress({
      address: "789 Elm St",
      city: "Lee's Summit",
      state: "MO",
      zip: "64086",
    });
    const b = normalizeAddress({
      address: "789 ELM ST",
      city: "lee's summit",
      state: "mo",
      zip: "64086",
    });
    expect(a).toBe(b);
  });

  it("fails closed when a single cache read returns a database error", async () => {
    const builder: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const method of ["select", "eq", "gte", "order", "limit"]) {
      builder[method] = vi.fn(() => builder);
    }
    builder.maybeSingle = vi.fn().mockResolvedValue({
      data: null,
      error: { message: "column org_id does not exist" },
    });
    const client = {
      from: vi.fn(() => builder),
    } as unknown as SupabaseClient<Database>;

    await expect(
      readCache(client, "org-1", "mock", "1 main st|kansas city|mo"),
    ).rejects.toThrow(/cache read failed/i);
  });

  it("fails closed when a bulk cache read returns a database error", async () => {
    const builder: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const method of ["select", "eq", "in", "gte"]) {
      builder[method] = vi.fn(() => builder);
    }
    builder.order = vi.fn().mockResolvedValue({
      data: null,
      error: { message: "cache unavailable" },
    });
    const client = {
      from: vi.fn(() => builder),
    } as unknown as SupabaseClient<Database>;

    await expect(
      readCacheMany(client, "org-1", "mock", ["1 main st|kansas city|mo"]),
    ).rejects.toThrow(/bulk read failed/i);
  });

  it("surfaces a failed cache upsert", async () => {
    const upsert = vi.fn().mockResolvedValue({
      error: { message: "write denied" },
    });
    const client = {
      from: vi.fn(() => ({ upsert })),
    } as unknown as SupabaseClient<Database>;

    await expect(
      writeCache(client, "org-1", "mock", "1 main st|kansas city|mo", {
        propertyId: "property-1",
        hit: false,
        persons: [],
        creditsDeducted: 0,
        raw: {},
      }),
    ).rejects.toThrow(/cache write failed/i);
  });
});
