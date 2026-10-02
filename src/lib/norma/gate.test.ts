import { describe, expect, it } from "vitest";

import { readNormaBlandConfig, readNormaGateConfig } from "./config";
import { evaluateNormaGate } from "./gate";

const ALLOWED = "+18165550142";
const OTHER = "+18165550199";

describe("dispatch gate", () => {
  it("defaults to closed with no env", () => {
    expect(readNormaGateConfig({})).toEqual({ dispatchEnabled: false, sellerRelease: false, allowedNumbers: [] });
    expect(evaluateNormaGate(ALLOWED, readNormaGateConfig({}))).toEqual({ open: false, reason: "dispatch_disabled" });
  });

  it("off refuses even an allowlisted number and even with seller release", () => {
    const config = readNormaGateConfig({ NORMA_DISPATCH_ENABLED: "false", NORMA_ALLOWED_NUMBERS: ALLOWED, NORMA_SELLER_RELEASE: "true" });
    expect(evaluateNormaGate(ALLOWED, config)).toEqual({ open: false, reason: "dispatch_disabled" });
  });

  it("on + not allowlisted refuses; on + allowlisted passes", () => {
    const config = readNormaGateConfig({ NORMA_DISPATCH_ENABLED: "true", NORMA_ALLOWED_NUMBERS: ` ${ALLOWED} , junk ,` });
    expect(config.allowedNumbers).toEqual([ALLOWED]);
    expect(evaluateNormaGate(OTHER, config)).toEqual({ open: false, reason: "number_not_allowed" });
    expect(evaluateNormaGate(ALLOWED, config)).toEqual({ open: true });
  });

  it("seller release opens any number, but only when dispatch is on", () => {
    const config = readNormaGateConfig({ NORMA_DISPATCH_ENABLED: "1", NORMA_SELLER_RELEASE: "true" });
    expect(evaluateNormaGate(OTHER, config)).toEqual({ open: true });
  });

  it("bland config is null unless every required value is valid", () => {
    const ok = {
      BLAND_API_KEY: "k", NORMA_BLAND_PATHWAY_ID: "p", NORMA_BLAND_PATHWAY_VERSION: "17",
      NORMA_BLAND_FROM_NUMBER: "+12135550100", NORMA_BLAND_WEBHOOK_URL: "https://x.test/h",
    };
    expect(readNormaBlandConfig(ok)).toMatchObject({ pathwayVersion: 17, timeoutMs: 10_000, baseUrl: "https://api.bland.ai" });
    expect(readNormaBlandConfig({ ...ok, NORMA_BLAND_PATHWAY_VERSION: "0.0.17" })).toBeNull();
    expect(readNormaBlandConfig({ ...ok, NORMA_BLAND_PATHWAY_VERSION: undefined })).toMatchObject({ pathwayVersion: 3 });
    expect(readNormaBlandConfig({ ...ok, NORMA_BLAND_WEBHOOK_URL: "http://x.test" })).toBeNull();
    expect(readNormaBlandConfig({ ...ok, BLAND_API_KEY: "" })).toBeNull();
  });
});
