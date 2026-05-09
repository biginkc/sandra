import { describe, it, expect } from "vitest";

describe("tokens/store", () => {
  it.todo("getDecryptedToken returns null when no row exists");
  it.todo(
    "getDecryptedToken throws ConfigurationError when OAUTH_TOKEN_ENCRYPTION_KEY is unset",
  );
  it.todo(
    "getDecryptedToken wraps access_token and refresh_token as OAuthSecret",
  );
  it.todo("upsertOAuthToken passes plaintext to RPC; never logs it");
});
