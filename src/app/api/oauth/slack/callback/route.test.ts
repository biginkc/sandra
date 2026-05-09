import { describe, it, expect } from "vitest";

describe("oauth/slack/callback route", () => {
  it.todo("returns 401-equivalent redirect on tampered state");
  it.todo("redirects to /login when not authenticated");
  it.todo(
    "on success calls exchangeSlackCode and persistOauthToken twice when user scopes returned",
  );
});
