import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  memberships: [] as Array<{
    user_id: string;
    org_id: string;
    role: "owner" | "member";
  }>,
  statusRow: null as {
    api_key_last_four: string;
    sending_enabled: boolean;
    test_mode: boolean;
  } | null,
  statusError: null as { message: string; code?: string } | null,
  validateCredentials: vi.fn(),
  saveEsignCredentials: vi.fn(),
  deleteEsignCredentials: vi.fn(),
  adminUpdate: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/auth/memberships", () => ({
  getCallerMemberships: async () => mocks.memberships,
}));
vi.mock("@/lib/esign/credentials", () => ({
  configuredDropboxSignClientId: () => "client-id",
  configuredDropboxSignEmbeddedDomain: () => "sandra.example.com",
  saveEsignCredentials: mocks.saveEsignCredentials,
  deleteEsignCredentials: mocks.deleteEsignCredentials,
}));
vi.mock("@/lib/esign/dropbox-sign", () => ({
  createDropboxSignProvider: () => ({
    validateCredentials: mocks.validateCredentials,
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: mocks.statusRow,
            error: mocks.statusError,
          }),
        }),
      }),
    }),
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      update: () => ({
        eq: mocks.adminUpdate,
      }),
    }),
  }),
}));

import {
  connectDropboxSignAction,
  disconnectDropboxSignAction,
  getEsignConnectionStatus,
  setEsignSendingEnabledAction,
} from "./actions";

describe("eSign server actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.memberships.splice(0, mocks.memberships.length, {
      user_id: "owner-1",
      org_id: "org-1",
      role: "owner",
    });
    mocks.statusRow = null;
    mocks.statusError = null;
    mocks.validateCredentials.mockResolvedValue({ accountId: "account-1" });
    mocks.saveEsignCredentials.mockResolvedValue(undefined);
    mocks.deleteEsignCredentials.mockResolvedValue(undefined);
    mocks.adminUpdate.mockResolvedValue({ error: null });
  });

  it("validates upstream before encrypting and returns only a mask", async () => {
    const result = await connectDropboxSignAction("dropbox-api-key-1234");
    expect(mocks.validateCredentials).toHaveBeenCalledOnce();
    expect(mocks.saveEsignCredentials).toHaveBeenCalledWith({
      orgId: "org-1",
      actorId: "owner-1",
      apiKey: "dropbox-api-key-1234",
      clientId: "client-id",
    });
    expect(result).toEqual({
      ok: true,
      data: {
        connected: true,
        canManage: true,
        sendingEnabled: false,
        testMode: true,
        apiKeyLastFour: "1234",
      },
    });
    expect(JSON.stringify(result)).not.toContain("dropbox-api-key-1234");
  });

  it("blocks members before any credential or provider work", async () => {
    mocks.memberships.splice(0, mocks.memberships.length, {
      user_id: "member-1",
      org_id: "org-1",
      role: "member",
    });
    const result = await connectDropboxSignAction("dropbox-api-key-1234");
    expect(result).toMatchObject({
      ok: false,
      error: { code: "AUTHORIZATION", message: expect.stringMatching(/owners/i) },
    });
    expect(mocks.validateCredentials).not.toHaveBeenCalled();
    expect(mocks.saveEsignCredentials).not.toHaveBeenCalled();
  });

  it("lets members view safe connection state without managing it", async () => {
    mocks.memberships.splice(0, mocks.memberships.length, {
      user_id: "member-1",
      org_id: "org-1",
      role: "member",
    });
    mocks.statusRow = {
      api_key_last_four: "9876",
      sending_enabled: true,
      test_mode: true,
    };
    await expect(getEsignConnectionStatus()).resolves.toEqual({
      ok: true,
      data: {
        connected: true,
        canManage: false,
        sendingEnabled: true,
        testMode: true,
        apiKeyLastFour: "9876",
      },
    });
  });

  it("keeps sending changes and disconnect owner-only", async () => {
    mocks.memberships.splice(0, mocks.memberships.length, {
      user_id: "member-1",
      org_id: "org-1",
      role: "member",
    });
    expect(await setEsignSendingEnabledAction(true)).toMatchObject({
      ok: false,
      error: { code: "AUTHORIZATION" },
    });
    expect(await disconnectDropboxSignAction()).toMatchObject({
      ok: false,
      error: { code: "AUTHORIZATION" },
    });
    expect(mocks.adminUpdate).not.toHaveBeenCalled();
    expect(mocks.deleteEsignCredentials).not.toHaveBeenCalled();
  });
});
