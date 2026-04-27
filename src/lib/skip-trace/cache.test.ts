import { describe, expect, it } from "vitest";

import { normalizeAddress } from "./cache";

describe("normalizeAddress", () => {
  it("lowercases and joins with pipe", () => {
    expect(
      normalizeAddress({
        address: "123 Main St",
        city: "Kansas City",
        state: "MO",
        zip: "64106",
      }),
    ).toBe("123 main st|kansas city|mo|64106");
  });

  it("skips null/undefined parts", () => {
    expect(
      normalizeAddress({
        address: "123 Main St",
        city: null,
        state: "MO",
        zip: undefined,
      }),
    ).toBe("123 main st|mo");
  });

  it("trims whitespace before lowercasing", () => {
    expect(
      normalizeAddress({
        address: "  456 Oak Ave  ",
        city: " St Louis ",
        state: " MO ",
      }),
    ).toBe("456 oak ave|st louis|mo");
  });

  it("two equivalent addresses with different formatting normalize the same", () => {
    const a = normalizeAddress({
      address: "789 Elm St",
      city: "Lee's Summit",
      state: "MO",
      zip: "64086",
    });
    const b = normalizeAddress({
      address: "789 ELM ST",
      city: "lee's summit",
      state: "mo",
      zip: "64086",
    });
    expect(a).toBe(b);
  });
});
