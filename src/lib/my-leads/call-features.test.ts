import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ flag: vi.fn(), ready: vi.fn() }));
vi.mock("./flags", () => ({ getMyLeadsFlag: mocks.flag }));
vi.mock("./schema-ready", () => ({ schemaReady: mocks.ready }));

import { getMyLeadsCallFeatures } from "./call-features";

describe("getMyLeadsCallFeatures", () => {
  beforeEach(() => {
    mocks.flag.mockReset();
    mocks.ready.mockReset();
  });

  it("turns each surface on only when its own flag and schema agree", async () => {
    mocks.flag.mockImplementation(async (_org: string, flag: string) => flag !== "callback_alert");
    mocks.ready.mockImplementation(async (feature: string) => feature !== "ack_prompts");
    expect(await getMyLeadsCallFeatures("org-1")).toEqual({ clickToDial: true, autoPrompt: false, callbackAlert: false });
    expect(mocks.flag).toHaveBeenCalledWith("org-1", "click_to_dial");
    expect(mocks.flag).toHaveBeenCalledWith("org-1", "auto_prompt");
    expect(mocks.flag).toHaveBeenCalledWith("org-1", "callback_alert");
    expect(mocks.ready).toHaveBeenCalledWith("api_dial");
    expect(mocks.ready).toHaveBeenCalledWith("ack_prompts");
    expect(mocks.ready).not.toHaveBeenCalledWith("callbacks_due");
  });

  it("is all off, without probing the schema, when every flag is off (missing row reads OFF)", async () => {
    mocks.flag.mockResolvedValue(false);
    expect(await getMyLeadsCallFeatures("org-1")).toEqual({ clickToDial: false, autoPrompt: false, callbackAlert: false });
    expect(mocks.ready).not.toHaveBeenCalled();
  });
});
