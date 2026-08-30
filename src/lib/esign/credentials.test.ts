import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const admin = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => admin,
}));

import {
  callbackPathSecretForOrg,
  deleteEsignCredentials,
  getEsignCredentials,
  saveEsignCredentials,
} from "./credentials";

describe("eSign credential store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ESIGN_CREDENTIAL_ENCRYPTION_KEY = "encryption-key";
    process.env.DROPBOX_SIGN_CALLBACK_SECRET_KEY = "callback-root-key";
  });

  afterEach(() => {
    delete process.env.ESIGN_CREDENTIAL_ENCRYPTION_KEY;
    delete process.env.DROPBOX_SIGN_CALLBACK_SECRET_KEY;
  });

  it("derives stable org-specific callback secrets without persisting plaintext", () => {
    const first = callbackPathSecretForOrg("org-1");
    const same = callbackPathSecretForOrg("org-1");
    const other = callbackPathSecretForOrg("org-2");
    expect(first.reveal()).toBe(same.reveal());
    expect(first.reveal()).not.toBe(other.reveal());
    expect(JSON.stringify(first)).not.toContain(first.reveal());
  });

  it("stores credentials through the encryption RPC with only a callback hash", async () => {
    admin.rpc.mockResolvedValue({ error: null });
    await saveEsignCredentials({
      orgId: "org-1",
      actorId: "user-1",
      apiKey: "dropbox-key-1234",
      clientId: "client-id",
    });
    const args = admin.rpc.mock.calls[0][1];
    expect(admin.rpc.mock.calls[0][0]).toBe("upsert_org_esign_integration");
    expect(args).toMatchObject({
      p_org_id: "org-1",
      p_api_key_last_four: "1234",
      p_client_id: "client-id",
      p_actor_id: "user-1",
      p_key: "encryption-key",
    });
    expect(args.p_callback_secret_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(args.p_callback_secret_hash).not.toBe(
      callbackPathSecretForOrg("org-1").reveal(),
    );
  });

  it("returns decrypted keys only as redacting server-side secret objects", async () => {
    admin.rpc.mockResolvedValue({
      data: [
        {
          api_key: "dropbox-key",
          client_id: "client-id",
          sending_enabled: true,
          test_mode: true,
          callback_secret_hash: "a".repeat(64),
        },
      ],
      error: null,
    });
    const credentials = await getEsignCredentials("org-1");
    expect(credentials?.apiKey.reveal()).toBe("dropbox-key");
    expect(JSON.stringify(credentials)).not.toContain("dropbox-key");
  });

  it("surfaces the safe disconnect blocker without leaking database details", async () => {
    admin.rpc.mockResolvedValue({ error: { code: "23514", message: "db detail" } });
    await expect(deleteEsignCredentials("org-1")).rejects.toThrow(
      "Finish active signatures and save signed PDFs",
    );
  });
});
