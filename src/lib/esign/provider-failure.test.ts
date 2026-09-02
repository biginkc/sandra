import { describe, expect, it } from "vitest";

import { ProviderError } from "@/lib/errors/classes";

import { classifyProviderFailure } from "./provider-failure";

describe("Dropbox Sign provider failure classification", () => {
  it("classifies 402 plan failures as terminal provider-plan failures", () => {
    expect(
      classifyProviderFailure(
        new ProviderError("Payment required", "dropbox_sign", {
          statusCode: 402,
          retryable: true,
        }),
      ),
    ).toBe("provider_plan_required");
  });

  it("preserves bounded 429 handling as ambiguous", () => {
    expect(
      classifyProviderFailure(
        new ProviderError("Rate limited", "dropbox_sign", {
          statusCode: 429,
        }),
      ),
    ).toBe("ambiguous");
  });
});
