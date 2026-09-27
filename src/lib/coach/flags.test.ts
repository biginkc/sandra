import { afterEach, describe, expect, it, vi } from "vitest";

import { isCoachScriptV2Enabled } from "./flags";

describe("isCoachScriptV2Enabled", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults off when a browser has no process object", () => {
    vi.stubGlobal("process", undefined);

    expect(isCoachScriptV2Enabled()).toBe(false);
  });

  it("defaults off when process has no environment object", () => {
    vi.stubGlobal("process", {});

    expect(isCoachScriptV2Enabled()).toBe(false);
  });

  it("enables V2 only for the explicit public flag", () => {
    vi.stubGlobal("process", { env: { NEXT_PUBLIC_COACH_SCRIPT_V2: "1" } });

    expect(isCoachScriptV2Enabled()).toBe(true);
  });
});
