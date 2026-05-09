import { describe, it, expect } from "vitest";

describe("oauth/google/callback route", () => {
  it.todo(
    "returns redirect to /settings/integrations?error=state on bad state",
  );
  it.todo(
    "on success calls exchangeGoogleCode and persistOauthToken once with tokenType='user'",
  );
});
