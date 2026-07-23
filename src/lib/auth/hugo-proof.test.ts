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

function hugoIdentityWithUpdatedAt(
  lastSignInTimestamp: number,
  updatedTimestamp: number,
) {
  return [
    {
      provider: "custom:hugo",
      last_sign_in_at: new Date(lastSignInTimestamp * 1_000).toISOString(),
      updated_at: new Date(updatedTimestamp * 1_000).toISOString(),
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

  it("accepts a repeat Hugo exchange when only updated_at advances", () => {
    expect(
      hasCurrentHugoOAuthProof(
        [{ method: "oauth", timestamp: oauthAt }],
        hugoIdentityWithUpdatedAt(oauthAt - 600, oauthAt + 30),
      ),
    ).toBe(true);
  });

  it("rejects a repeat exchange when both identity timestamps are stale", () => {
    expect(
      hasCurrentHugoOAuthProof(
        [{ method: "oauth", timestamp: oauthAt }],
        hugoIdentityWithUpdatedAt(oauthAt - 600, oauthAt - 61),
      ),
    ).toBe(false);
  });

  it("does not accept a current updated_at from a different provider", () => {
    expect(
      hasCurrentHugoOAuthProof(
        [{ method: "oauth", timestamp: oauthAt }],
        [
          {
            provider: "google",
            last_sign_in_at: new Date((oauthAt - 600) * 1_000).toISOString(),
            updated_at: new Date((oauthAt + 30) * 1_000).toISOString(),
          },
        ],
      ),
    ).toBe(false);
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
