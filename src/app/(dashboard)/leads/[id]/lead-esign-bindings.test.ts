import { describe, expect, it } from "vitest";

import { mapAtomicSendBlocker } from "./lead-esign-bindings";

describe("atomic eSign send blocker mapping", () => {
  it.each([
    ["ACTIVE_MEMBERSHIP_REQUIRED", "authorization_changed"],
    ["PROPERTY_NOT_FOUND", "not_found"],
  ] as const)("maps %s to the distinct safe %s outcome", (code, outcome) => {
    const result = mapAtomicSendBlocker(code);
    expect(result).toEqual({ outcome });
    expect(JSON.stringify(result)).not.toMatch(/property id|email|address/i);
  });
});
