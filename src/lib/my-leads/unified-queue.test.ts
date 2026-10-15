import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ flag: vi.fn(), ready: vi.fn() }));
vi.mock("./flags", () => ({ getMyLeadsFlag: mocks.flag }));
vi.mock("./schema-ready", () => ({ schemaReady: mocks.ready }));

import { unifiedQueueEnabled } from "./unified-queue";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.flag.mockResolvedValue(true);
  mocks.ready.mockResolvedValue(true);
});

describe("unifiedQueueEnabled", () => {
  it("needs the org flag AND the schema", async () => {
    expect(await unifiedQueueEnabled("org-1")).toBe(true);
    expect(mocks.flag).toHaveBeenCalledWith("org-1", "unified_queue");
    expect(mocks.ready).toHaveBeenCalledWith("unified_queue");
  });

  it("is off when the flag is off, without probing the schema", async () => {
    mocks.flag.mockResolvedValue(false);
    expect(await unifiedQueueEnabled("org-1")).toBe(false);
    expect(mocks.ready).not.toHaveBeenCalled();
  });

  it("is off when the schema has not landed", async () => {
    mocks.ready.mockResolvedValue(false);
    expect(await unifiedQueueEnabled("org-1")).toBe(false);
  });

  it("is off on any thrown error", async () => {
    mocks.flag.mockRejectedValue(new Error("boom"));
    expect(await unifiedQueueEnabled("org-1")).toBe(false);
    mocks.flag.mockResolvedValue(true);
    mocks.ready.mockRejectedValue(new Error("boom"));
    expect(await unifiedQueueEnabled("org-1")).toBe(false);
  });
});
