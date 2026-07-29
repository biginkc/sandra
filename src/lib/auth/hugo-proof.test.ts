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

  it("rejects a malformed updated_at on the exact Hugo identity", () => {
    expect(
      hasCurrentHugoOAuthProof(
        [{ method: "oauth", timestamp: oauthAt }],
        [
          {
            provider: "custom:hugo",
            last_sign_in_at: new Date((oauthAt - 600) * 1_000).toISOString(),
            updated_at: "not-a-date",
          },
        ],
      ),
    ).toBe(false);
  });

  it("accepts hosted custom-provider exchanges when updated_at advances but last_sign_in_at stays stale", () => {
    expect(
      hasCurrentHugoOAuthProof(
        [{ method: "oauth", timestamp: oauthAt }],
        [
          {
            provider: "custom:hugo",
            last_sign_in_at: new Date((oauthAt - 600) * 1_000).toISOString(),
            updated_at: new Date((oauthAt + 30) * 1_000).toISOString(),
          },
        ],
      ),
    ).toBe(true);
  });

  it("rejects a recent updated_at from another linked provider", () => {
    expect(
      hasCurrentHugoOAuthProof(
        [{ method: "oauth", timestamp: oauthAt }],
        [
          {
            provider: "custom:hugo",
            last_sign_in_at: new Date((oauthAt - 600) * 1_000).toISOString(),
          },
          {
            provider: "google",
            last_sign_in_at: new Date((oauthAt - 600) * 1_000).toISOString(),
            updated_at: new Date((oauthAt + 30) * 1_000).toISOString(),
          },
        ],
      ),
    ).toBe(false);
  });

  it("rejects a repeat exchange when both identity timestamps are stale", () => {
    expect(
      hasCurrentHugoOAuthProof(
        [{ method: "oauth", timestamp: oauthAt }],
        [
          {
            provider: "custom:hugo",
            last_sign_in_at: new Date((oauthAt - 61) * 1_000).toISOString(),
            updated_at: new Date((oauthAt - 62) * 1_000).toISOString(),
          },
        ],
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
