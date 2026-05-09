import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/types";
import { createTestClient } from "@tests/integration/client";

import { getDecryptedToken, upsertOAuthToken } from "./store";

const supabase = createTestClient();
const createdAuthUsers: string[] = [];

type OAuthTokenReader = {
  from(table: "user_oauth_tokens"): {
    select(columns: string): {
      eq(
        column: "user_id",
        value: string,
      ): Promise<{ data: unknown[] | null; error: { message: string } | null }>;
    };
  };
};

async function createAuthUser(email: string): Promise<{
  id: string;
  email: string;
  password: string;
}> {
  const password = `test-pw-${Math.random().toString(36).slice(2)}`;
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) {
    throw new Error(`createAuthUser(${email}) failed: ${error?.message}`);
  }
  createdAuthUsers.push(data.user.id);
  return { id: data.user.id, email, password };
}

describe("tokens/store integration", () => {
  let userOne: Awaited<ReturnType<typeof createAuthUser>>;
  let userTwo: Awaited<ReturnType<typeof createAuthUser>>;

  beforeAll(async () => {
    vi.stubEnv("OAUTH_TOKEN_ENCRYPTION_KEY", "integration-oauth-key");
    userOne = await createAuthUser(`oauth-u1-${Date.now()}@test.invalid`);
    userTwo = await createAuthUser(`oauth-u2-${Date.now()}@test.invalid`);
  });

  afterAll(async () => {
    for (const id of createdAuthUsers) {
      await supabase.auth.admin.deleteUser(id);
    }
    vi.unstubAllEnvs();
  });

  it("pgp_sym_encrypt -> pgp_sym_decrypt round-trip preserves token bytes", async () => {
    await upsertOAuthToken({
      userId: userOne.id,
      provider: "slack",
      tokenType: "bot",
      accessToken: "xoxb-roundtrip",
      refreshToken: "xoxr-roundtrip",
      accessTokenExpiresAt: "2026-05-09T20:00:00.000Z",
      scopes: ["chat:write"],
      externalAccountId: "B123",
    });

    const token = await getDecryptedToken({
      userId: userOne.id,
      provider: "slack",
      tokenType: "bot",
    });

    expect(token?.accessToken.reveal()).toBe("xoxb-roundtrip");
    expect(token?.refreshToken?.reveal()).toBe("xoxr-roundtrip");
  });

  it("upsert with null refresh_token preserves existing refresh_token (COALESCE)", async () => {
    await upsertOAuthToken({
      userId: userOne.id,
      provider: "slack",
      tokenType: "bot",
      accessToken: "xoxb-v2",
      refreshToken: null,
      accessTokenExpiresAt: "2026-05-09T21:00:00.000Z",
      scopes: ["chat:write", "im:write"],
      externalAccountId: "B123",
    });

    const token = await getDecryptedToken({
      userId: userOne.id,
      provider: "slack",
      tokenType: "bot",
    });

    expect(token?.accessToken.reveal()).toBe("xoxb-v2");
    expect(token?.refreshToken?.reveal()).toBe("xoxr-roundtrip");
  });

  it("RLS: user can SELECT own row; cannot read another user's encrypted columns", async () => {
    const anon = createClient<Database>(
      process.env.TEST_SUPABASE_URL ?? "",
      process.env.TEST_SUPABASE_ANON_KEY ?? "",
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const { error: signInError } = await anon.auth.signInWithPassword({
      email: userTwo.email,
      password: userTwo.password,
    });
    expect(signInError).toBeNull();

    const { data, error } = await (anon as unknown as OAuthTokenReader)
      .from("user_oauth_tokens")
      .select("*")
      .eq("user_id", userOne.id);

    expect(error).toBeNull();
    expect(data).toEqual([]);
  });
});
