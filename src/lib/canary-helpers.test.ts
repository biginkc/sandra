import { describe, expect, it } from "vitest";

import { resolveCanarySmsReceiver } from "../../scripts/canary-helpers";

describe("resolveCanarySmsReceiver", () => {
  it("accepts the allowlisted receiver", () => {
    expect(
      resolveCanarySmsReceiver({
        receiver: "+18160000001",
        allowlist: "+18160000001,+18160000002",
      }),
    ).toBe("+18160000001");
  });

  it("rejects non-E.164 receivers", () => {
    expect(() =>
      resolveCanarySmsReceiver({
        receiver: "5550000001",
        allowlist: "5550000001,+18160000001",
      }),
    ).toThrow("valid E.164");
  });

  it("rejects allowlist-missing receiver", () => {
    expect(() =>
      resolveCanarySmsReceiver({
        receiver: "+18160000001",
        allowlist: "+18160000002",
      }),
    ).toThrow("not present in PROD_CANARY_SMS_ALLOWLIST");
  });

  it("rejects missing allowlist", () => {
    expect(() =>
      resolveCanarySmsReceiver({
        receiver: "+18160000001",
      }),
    ).toThrow("required and must include the receiver");
  });
});
