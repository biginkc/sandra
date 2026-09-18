import { describe, expect, it } from "vitest";

import {
  hasOpeningIdentity,
  openingIdentityError,
  OPENING_IDENTITY,
} from "./opening-identity";

describe("opening identity", () => {
  it("recognizes the literal identity with a word boundary", () => {
    expect(hasOpeningIdentity(`Hi, ${OPENING_IDENTITY} here.`)).toBe(true);
    expect(hasOpeningIdentity("Hi, Mel with BMHack here.")).toBe(false);
    expect(openingIdentityError("Hi, Mel with BMHack here.")).toContain(OPENING_IDENTITY);
  });
});
