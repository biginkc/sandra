import { afterEach, describe, expect, it, vi } from "vitest";

import { isCoachScriptV2Enabled, isCoachWireDigestStrict } from "./flags";

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

describe("isCoachWireDigestStrict", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults off when a browser has no process object", () => {
    vi.stubGlobal("process", undefined);

    expect(isCoachWireDigestStrict()).toBe(false);
  });

  it("defaults off when process has no environment object", () => {
    vi.stubGlobal("process", {});

    expect(isCoachWireDigestStrict()).toBe(false);
  });

  it("enables strict validation only for the explicit public flag", () => {
    vi.stubGlobal("process", { env: { NEXT_PUBLIC_COACH_WIRE_DIGEST_STRICT: "1" } });

    expect(isCoachWireDigestStrict()).toBe(true);
  });
});
