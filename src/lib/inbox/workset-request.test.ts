import { describe, expect, it } from "vitest";
import { parseInboxWorksetRequest } from "./workset-request";

const orgId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const replacesScopeId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const request = { orgId, filter: { view: "active" }, cursor: null, limit: 500 };

describe("workset request envelope", () => {
  it("preserves optional explicit replacement without implicitly replacing another scope", () => {
    expect(parseInboxWorksetRequest(request)).toEqual(request);
    expect(parseInboxWorksetRequest({ ...request, replacesScopeId })).toEqual({ ...request, replacesScopeId });
    expect(parseInboxWorksetRequest(request)).not.toHaveProperty("replacesScopeId");
  });
  it.each([null, "", "other-session", 3, {}, undefined])("rejects malformed explicit replacement %s", value => {
    expect(parseInboxWorksetRequest({ ...request, replacesScopeId: value })).toBeNull();
  });
  it.each(["targets", "userId", "sessionId", "accessEpoch", "generation", "handle", "where"])("rejects client-controlled authority field %s", key => {
    expect(parseInboxWorksetRequest({ ...request, [key]: "forged" })).toBeNull();
  });
  it.each([0, 501, -1, 1.5, "100", NaN, Infinity])("rejects unbounded or coerced limit %s", limit => {
    expect(parseInboxWorksetRequest({ ...request, limit })).toBeNull();
  });
  it("rejects missing or oversized cursor and invalid envelope without coercion", () => {
    for (const cursor of [undefined, "", "x".repeat(4097), 3, {}]) expect(parseInboxWorksetRequest({ ...request, cursor })).toBeNull();
    for (const value of [null, [], "", { ...request, filter: [] }, { ...request, orgId: "bad" }]) expect(parseInboxWorksetRequest(value)).toBeNull();
  });
});
