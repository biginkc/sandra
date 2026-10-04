import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ flag: vi.fn(), ready: vi.fn() }));
vi.mock("./flags", () => ({ getMyLeadsFlag: mocks.flag }));
vi.mock("./schema-ready", () => ({ schemaReady: mocks.ready }));

import { postCallPromptEnabled } from "./post-call";

describe("postCallPromptEnabled", () => {
  beforeEach(() => {
    mocks.flag.mockReset();
    mocks.ready.mockReset();
  });

  it("is on only when the flag is on and the P1c schema is ready", async () => {
    mocks.flag.mockResolvedValue(true);
    mocks.ready.mockResolvedValue(true);
    expect(await postCallPromptEnabled("org-1")).toBe(true);
    expect(mocks.flag).toHaveBeenCalledWith("org-1", "post_call_prompt");
    expect(mocks.ready).toHaveBeenCalledWith("post_call_support");
  });

  it("is off, without probing the schema, when the flag is off", async () => {
    mocks.flag.mockResolvedValue(false);
    expect(await postCallPromptEnabled("org-1")).toBe(false);
    expect(mocks.ready).not.toHaveBeenCalled();
  });

  it("is off when the flag is on but the migration has not landed", async () => {
    mocks.flag.mockResolvedValue(true);
    mocks.ready.mockResolvedValue(false);
    expect(await postCallPromptEnabled("org-1")).toBe(false);
  });
});
