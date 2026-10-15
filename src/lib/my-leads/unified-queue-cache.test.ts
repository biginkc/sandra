import { describe, expect, it, vi } from "vitest";

// React's cache() only memoizes inside a server request, so assert the wiring: the export is the
// function returned by cache(), memoized per orgId, so the page and the sidebar badge share one read.
const mocks = vi.hoisted(() => {
  const memo = new Map<string, Promise<boolean>>();
  return {
    flag: vi.fn(),
    ready: vi.fn(),
    cacheWrapped: vi.fn(),
    memo,
    cache: (fn: (orgId: string) => Promise<boolean>) => {
      const wrapped = (orgId: string) => {
        if (!memo.has(orgId)) memo.set(orgId, fn(orgId));
        return memo.get(orgId)!;
      };
      return wrapped;
    },
  };
});
vi.mock("react", () => ({
  cache: (fn: (orgId: string) => Promise<boolean>) => {
    mocks.cacheWrapped();
    return mocks.cache(fn);
  },
}));
vi.mock("./flags", () => ({ getMyLeadsFlag: mocks.flag }));
vi.mock("./schema-ready", () => ({ schemaReady: mocks.ready }));

import { unifiedQueueEnabled } from "./unified-queue";

describe("unifiedQueueEnabled request sharing", () => {
  it("is wrapped in React cache and reads the flag and schema once per org per request", async () => {
    expect(mocks.cacheWrapped).toHaveBeenCalledOnce();
    mocks.flag.mockResolvedValue(true);
    mocks.ready.mockResolvedValue(true);
    const [page, badge] = await Promise.all([unifiedQueueEnabled("org-1"), unifiedQueueEnabled("org-1")]);
    expect([page, badge]).toEqual([true, true]);
    expect(mocks.flag).toHaveBeenCalledTimes(1);
    expect(mocks.ready).toHaveBeenCalledTimes(1);
  });
});
