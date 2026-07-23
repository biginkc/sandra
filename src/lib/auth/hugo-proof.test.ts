import { describe, expect, it } from "vitest";

import { hasCurrentHugoOAuthProof } from "./hugo-proof";

const oauthAt = 1_784_616_840;

function hugoIdentity(timestamp: number) {
  return [
    {
      provider: "custom:hugo",
      last_sign_in_at: new Date(timestamp * 1_000).toISOString(),
    },
  ];
}

describe("hasCurrentHugoOAuthProof", () => {
  it("accepts a Hugo identity updated by the current OAuth exchange", () => {
    expect(
      hasCurrentHugoOAuthProof(
        [{ method: "oauth", timestamp: oauthAt }],
        hugoIdentity(oauthAt + 30),
      ),
    ).toBe(true);
  });

  it.each([oauthAt - 61, oauthAt + 61, oauthAt + 1_000])(
    "rejects a Hugo identity from a different session at %s",
    (identityTimestamp) => {
      expect(
        hasCurrentHugoOAuthProof(
          [{ method: "oauth", timestamp: oauthAt }],
          hugoIdentity(identityTimestamp),
        ),
      ).toBe(false);
    },
  );
});
