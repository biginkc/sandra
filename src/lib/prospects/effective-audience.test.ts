import { describe, expect, it } from "vitest";

import {
  EMPTY_AUDIENCE_VALIDATION_MESSAGE,
  hasEffectiveAudience,
  isEffectiveBlock,
} from "./effective-audience";
import type { FilterBlock } from "./filter-schema";

describe("effective audience helpers", () => {
  it("treats tri:any, empty multiselects, and empty ranges as ineffective", () => {
    expect(
      isEffectiveBlock({
        id: "vacancy-any",
        kind: "vacancy",
        tri: "any",
      }),
    ).toBe(false);
    expect(
      isEffectiveBlock({
        id: "state-empty",
        kind: "state",
        combinator: "any",
        values: [],
      }),
    ).toBe(false);
    expect(
      isEffectiveBlock({
        id: "beds-empty",
        kind: "beds",
        range: { min: null, max: null },
      }),
    ).toBe(false);
  });

  it("treats real predicates and free-text search as effective audience", () => {
    expect(
      isEffectiveBlock({
        id: "vacancy-yes",
        kind: "vacancy",
        tri: "yes",
      }),
    ).toBe(true);
    expect(
      isEffectiveBlock({
        id: "state-mo",
        kind: "state",
        combinator: "any",
        values: ["MO"],
      }),
    ).toBe(true);
    expect(
      isEffectiveBlock({
        id: "created-since",
        kind: "created_date",
        date: { mode: "since", days: 30 },
      }),
    ).toBe(true);
    expect(
      hasEffectiveAudience({
        search: "oak",
        blockStack: [],
      }),
    ).toBe(true);
  });

  it("treats a fixed created_date with no bounds as ineffective", () => {
    const block: FilterBlock = {
      id: "created-fixed-empty",
      kind: "created_date",
      date: { mode: "fixed", from: null, to: null },
    };

    expect(isEffectiveBlock(block)).toBe(false);
    expect(
      hasEffectiveAudience({
        search: null,
        blockStack: [block],
      }),
    ).toBe(false);
    expect(EMPTY_AUDIENCE_VALIDATION_MESSAGE).toContain("target every prospect");
  });
});
