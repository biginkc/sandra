import { describe, expect, it } from "vitest";
import { inboxViews, parseInboxFilter } from "./filter-contract";
describe("canonical Inbox filter envelope", () => {
  it.each(inboxViews)("preserves supported view %s", view => expect(parseInboxFilter({ view })).toEqual({ view }));
  it("leaves normalization to canonical SQL while preserving explicit noise choice", () => {
    expect(parseInboxFilter({ view: "all", search: "  ab  ", hide_noise: false })).toEqual({ view: "all", search: "  ab  ", hide_noise: false });
  });
  it.each([{ view: "review" }, { view: "all", hide_noise: "false" }, { view: "mine", userId: "other" }, { view: "unknown", search: null }, null, []])("rejects unsupported or forged filter %j", value => expect(parseInboxFilter(value)).toBeNull());
});
