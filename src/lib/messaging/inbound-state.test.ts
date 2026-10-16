import { describe, expect, it } from "vitest";

import { markInboundMessageState } from "./inbound-state";

function client(updateResult: { data: unknown; error: { message: string } | null }) {
  return {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { metadata: {} }, error: null }) }) }),
      update: () => ({
        eq: () => ({ select: () => ({ maybeSingle: async () => updateResult }) }),
      }),
    }),
  } as never;
}

describe("markInboundMessageState", () => {
  it("resolves when the stamp matched the row", async () => {
    await expect(
      markInboundMessageState(client({ data: { id: "m" }, error: null }), "m", {}),
    ).resolves.toBeUndefined();
  });

  it("throws when the update matched no row (an unconfirmed stamp is not a stamp)", async () => {
    await expect(
      markInboundMessageState(client({ data: null, error: null }), "m", {}),
    ).rejects.toThrow(/matched no row/);
  });

  it("throws on an update error", async () => {
    await expect(
      markInboundMessageState(client({ data: null, error: { message: "boom" } }), "m", {}),
    ).rejects.toThrow(/boom/);
  });
});
