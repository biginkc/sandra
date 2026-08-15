import { describe, expect, it } from "vitest";

import {
  IMPORT_SERVICE_PRICING,
  IMPORT_SERVICE_DEFAULTS,
  estimateMaxCostUsd,
  sumEnabledImportServiceEstimates,
} from "./import-pricing";

describe("import paid-service safety", () => {
  it("keeps all paid choices off in the zero-value wizard defaults", () => {
    expect(IMPORT_SERVICE_DEFAULTS).toEqual({ requestCass: false, classifyLineTypes: false, requestSkipTrace: false });
    expect(IMPORT_SERVICE_PRICING.cass.configured).toBe(false);
    expect(IMPORT_SERVICE_PRICING.cass.unitPriceUsd).toBeNull();
    expect(IMPORT_SERVICE_PRICING.skip_trace.configured).toBe(false);
    expect(IMPORT_SERVICE_PRICING.skip_trace.unitPriceUsd).toBeNull();
    expect(IMPORT_SERVICE_PRICING.line_type.configured).toBe(false);
  });

  it("uses the central unit prices and sums only enabled services", () => {
    const line = estimateMaxCostUsd(IMPORT_SERVICE_PRICING.line_type.unitPriceUsd, 20);
    expect(sumEnabledImportServiceEstimates({
      requestCass: false,
      classifyLineTypes: true,
      requestSkipTrace: false,
      cassEligible: 100,
      lineTypeEligible: 20,
      skipTraceEligible: 0,
    })).toBe(line);
    expect(IMPORT_SERVICE_PRICING.line_type.unitPriceUsd).toBe(0.004);
  });
});
