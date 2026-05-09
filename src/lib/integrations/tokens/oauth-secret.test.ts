import { describe, expect, it } from "vitest";

import { OAuthSecret } from "./oauth-secret";

describe("OAuthSecret", () => {
  it("reveal returns the underlying value", () => {
    expect(new OAuthSecret("xoxb-foo").reveal()).toBe("xoxb-foo");
  });

  it("toJSON returns [REDACTED]", () => {
    expect(new OAuthSecret("xoxb-foo").toJSON()).toBe("[REDACTED]");
  });

  it("toString returns [REDACTED]", () => {
    expect(new OAuthSecret("xoxb-foo").toString()).toBe("[REDACTED]");
  });

  it("JSON.stringify does not leak the value", () => {
    const json = JSON.stringify({ token: new OAuthSecret("xoxb-foo") });
    expect(json).not.toContain("xoxb-foo");
    expect(json).toContain("[REDACTED]");
  });

  it("the underlying value is non-enumerable", () => {
    const secret = new OAuthSecret("xoxb-foo");
    expect(Object.keys(secret)).not.toContain("_value");
  });
});
