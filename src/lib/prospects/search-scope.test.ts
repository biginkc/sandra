import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { getCallerMembershipsOrThrowMock } = vi.hoisted(() => ({
  getCallerMembershipsOrThrowMock: vi.fn(),
}));
vi.mock("@/lib/auth/memberships", () => ({
  getCallerMembershipsOrThrow: getCallerMembershipsOrThrowMock,
}));

import type { BlockStack } from "./filter-schema";
import {
  SEARCH_DEGRADED_NOTICE,
  SEARCH_SELECT_ALL_CAP,
  SEARCH_TOO_BROAD_MESSAGE,
  buildScopedQuery,
  escapeLikePattern,
  mapSearchError,
  normalizeSearchTerm,
  resolveIncludeMessages,
  runWithSearchFallback,
  searchModeFor,
} from "./search-scope";

/** Records every builder call as `method(arg,arg)` and returns itself. */
function recorder() {
  const calls: string[] = [];
  const fmt = (args: unknown[]) => {
    const a = [...args];
    while (a.length && a[a.length - 1] === undefined) a.pop();
    return a.map((x) => JSON.stringify(x)).join(",");
  };
  const handler: ProxyHandler<object> = {
    get(_t, prop: string) {
      if (prop === "then") return undefined;
      return (...args: unknown[]) => {
        calls.push(`${prop}(${fmt(args)})`);
        return proxy;
      };
    },
  };
  const proxy: unknown = new Proxy({}, handler);
  const client = {
    from: (table: string) => {
      calls.push(`from(${table})`);
      return proxy;
    },
    rpc: (...args: unknown[]) => {
      calls.push(`rpc(${fmt(args)})`);
      return proxy;
    },
  };
  return { calls, client: client as never };
}

const NO_BLOCKS: BlockStack = [];

describe("search helpers", () => {
  it("escapes ILIKE metacharacters", () => {
    expect(escapeLikePattern("a%b_c\\d")).toBe("a\\%b\\_c\\\\d");
    expect(escapeLikePattern("plain")).toBe("plain");
  });

  it("normalizes whitespace like the RPC", () => {
    expect(normalizeSearchTerm("  jane \t\n  doe ")).toBe("jane doe");
    expect(normalizeSearchTerm(null)).toBe("");
  });

  it.each([
    [null, "none"],
    ["", "none"],
    ["   ", "none"],
    ["ab", "address_short"],
    [" a ", "address_short"],
    ["abc", "rpc"],
    ["a  b", "rpc"], // 3 chars after collapse
  ] as const)("searchModeFor(%j) = %s", (search, mode) => {
    expect(searchModeFor(search)).toBe(mode);
  });
});

describe("buildScopedQuery: Search scope", () => {
  it("empty search: plain table, every status, training hidden", async () => {
    const { calls, client } = recorder();
    const { mode } = await buildScopedQuery(client, {
      select: "id, status",
      search: null,
      blockStack: NO_BLOCKS,
    });
    expect(mode).toBe("none");
    expect(calls).toEqual([
      "from(properties)",
      'select("id, status")',
      'is("deleted_at",null)',
      'eq("is_training",false)',
    ]);
  });

  it("1-2 chars: escaped address ilike, no RPC", async () => {
    const { calls, client } = recorder();
    const { mode } = await buildScopedQuery(client, {
      select: "id",
      search: "a%",
      blockStack: NO_BLOCKS,
    });
    expect(mode).toBe("address_short");
    expect(calls).toContain('ilike("address","%a\\\\%%")');
    expect(calls.some((c) => c.startsWith("rpc("))).toBe(false);
  });

  it("3+ chars: RPC with q, server-derived include_messages; count/head ride the rpc 3rd arg", async () => {
    const { calls, client } = recorder();
    const { mode } = await buildScopedQuery(client, {
      select: "id, address",
      selectOpts: { count: "exact", head: true },
      search: "  Jane   Doe ",
      blockStack: NO_BLOCKS,
      includeMessages: false,
    });
    expect(mode).toBe("rpc");
    expect(calls).toEqual([
      'rpc("search_properties",{"q":"Jane Doe","include_messages":false},{"count":"exact","head":true})',
      'select("id, address")',
      'eq("is_training",false)',
    ]);
  });

  it("include_messages defaults to false (fail-closed) when the caller did not resolve it", async () => {
    const { calls, client } = recorder();
    await buildScopedQuery(client, {
      select: "id",
      search: "jane",
      blockStack: NO_BLOCKS,
    });
    expect(calls[0]).toContain('"include_messages":false');
    const withMessages = recorder();
    await buildScopedQuery(withMessages.client, {
      select: "id",
      search: "jane",
      blockStack: NO_BLOCKS,
      includeMessages: true,
    });
    expect(withMessages.calls[0]).toContain('"include_messages":true');
  });

  it("RPC missing (addressFallback): escaped address search instead of the RPC", async () => {
    const { calls, client } = recorder();
    const { mode } = await buildScopedQuery(client, {
      select: "id",
      search: "jane_doe",
      blockStack: NO_BLOCKS,
      addressFallback: true,
    });
    expect(mode).toBe("address_short");
    expect(calls).toContain('ilike("address","%jane\\\\_doe%")');
    expect(calls.some((c) => c.startsWith("rpc("))).toBe(false);
  });

  it("does not add the legacy status predicate even with filter blocks", async () => {
    const { calls, client } = recorder();
    await buildScopedQuery(client, {
      select: "id",
      search: null,
      blockStack: [
        { id: "ps", kind: "pipeline_status", combinator: "any", values: ["dead"] },
      ] as BlockStack,
    });
    expect(calls.join("\n")).not.toContain("is_dnc_locked.eq.true");
  });
});

describe("error mapping", () => {
  it("maps statement timeout to the friendly message", () => {
    expect(mapSearchError({ code: "57014", message: "canceling statement" })).toEqual({
      code: "SEARCH_TOO_BROAD",
      message: SEARCH_TOO_BROAD_MESSAGE,
    });
    expect(SEARCH_TOO_BROAD_MESSAGE).toBe(
      "Search too broad — try a more specific name, phone or address",
    );
  });

  it("maps a missing function to the degraded notice", () => {
    expect(mapSearchError({ code: "PGRST202", message: "Could not find" })).toEqual({
      code: "SEARCH_UNAVAILABLE",
      message: SEARCH_DEGRADED_NOTICE,
    });
  });

  it("passes other errors through and ignores null", () => {
    expect(mapSearchError({ code: "42703", message: "bad column" })).toEqual({
      code: "QUERY_FAILED",
      message: "bad column",
    });
    expect(mapSearchError(null)).toBeNull();
  });
});

describe("runWithSearchFallback", () => {
  it("reruns once as an address fallback when the RPC is missing", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ error: { code: "PGRST202" }, data: null })
      .mockResolvedValueOnce({ error: null, data: [1] });
    const out = await runWithSearchFallback(run);
    expect(run).toHaveBeenNthCalledWith(1, { addressFallback: false });
    expect(run).toHaveBeenNthCalledWith(2, { addressFallback: true });
    expect(out.degraded).toBe(true);
    expect((out.result as unknown as { data: unknown }).data).toEqual([1]);
  });

  it("does not retry other errors (e.g. timeout) or successes", async () => {
    const timeout = vi.fn().mockResolvedValue({ error: { code: "57014" } });
    expect((await runWithSearchFallback(timeout)).degraded).toBe(false);
    expect(timeout).toHaveBeenCalledTimes(1);
    const fine = vi.fn().mockResolvedValue({ error: null });
    expect((await runWithSearchFallback(fine)).degraded).toBe(false);
    expect(fine).toHaveBeenCalledTimes(1);
  });
});

describe("resolveIncludeMessages (server-derived, fail-closed)", () => {
  const membership = (role: string, acquisitions: boolean) => ({
    user_id: "u",
    org_id: "o",
    role,
    acquisitions_enabled: acquisitions,
    access_status: "active",
    access_expires_at: null,
    deletion_prepared_at: null,
  });

  beforeEach(() => {
    getCallerMembershipsOrThrowMock.mockReset();
  });

  it("members and owners may match messages", async () => {
    getCallerMembershipsOrThrowMock.mockResolvedValue([membership("member", false)]);
    expect(await resolveIncludeMessages()).toBe(true);
    getCallerMembershipsOrThrowMock.mockResolvedValue([membership("owner", true)]);
    expect(await resolveIncludeMessages()).toBe(true);
  });

  it("a restricted Acquisitions member may not", async () => {
    getCallerMembershipsOrThrowMock.mockResolvedValue([membership("member", true)]);
    expect(await resolveIncludeMessages()).toBe(false);
  });

  it("no active membership is denied, never 'unrestricted'", async () => {
    getCallerMembershipsOrThrowMock.mockResolvedValue([]);
    expect(await resolveIncludeMessages()).toBe(false);
  });

  it("a lookup failure rejects so callers can surface an error", async () => {
    getCallerMembershipsOrThrowMock.mockRejectedValue(new Error("lookup failed"));
    await expect(resolveIncludeMessages()).rejects.toThrow("lookup failed");
  });
});

describe("constants and static guards", () => {
  it("select-all cap is the measured value and stays under the 1 MB Server Action body (~39 bytes per id)", () => {
    expect(SEARCH_SELECT_ALL_CAP).toBe(20_000);
    expect(SEARCH_SELECT_ALL_CAP * 39).toBeLessThan(1_000_000);
    expect(readFileSync(path.join(__dirname, "search-scope.ts"), "utf8")).not.toContain("TODO(volume-tuning)");
  });

  function sourceFiles(): string[] {
    const root = path.resolve(__dirname, "../..");
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.|types\.ts$/.test(name)) out.push(full);
      }
    };
    walk(root);
    return out;
  }

  it("search_properties is never called through the admin client (auth.uid() would be null)", () => {
    // search-scope takes the caller's client as a parameter and must not build its own admin client.
    const scope = readFileSync(path.join(__dirname, "search-scope.ts"), "utf8");
    expect(scope).not.toMatch(/from\s+["']@\/lib\/supabase\/admin["']/);
    expect(scope).not.toMatch(/createAdminClient\(/);
    // No caller hands buildScopedQuery an admin-named client.
    const offenders = sourceFiles().filter((f) =>
      /buildScopedQuery\(\s*(admin|adminClient|serviceClient)\b/.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("only search-scope.ts calls the RPC from application code", () => {
    const root = path.resolve(__dirname, "../..");
    const callers = sourceFiles()
      .filter((f) => /rpc\(\s*["']search_properties|SEARCH_RPC_NAME/.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(root, f));
    expect(callers).toEqual(["lib/prospects/search-scope.ts"]);
  });
});
