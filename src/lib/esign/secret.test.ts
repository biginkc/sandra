import { describe, expect, it } from "vitest";

import { EsignSecret } from "./secret";

describe("EsignSecret", () => {
  it("reveals only explicitly and redacts serialization", () => {
    const secret = new EsignSecret("dropbox-api-key");
    expect(secret.reveal()).toBe("dropbox-api-key");
    expect(secret.toString()).toBe("[REDACTED]");
    expect(JSON.stringify({ secret })).toBe('{"secret":"[REDACTED]"}');
    expect(Object.keys(secret)).toEqual([]);
  });
});
