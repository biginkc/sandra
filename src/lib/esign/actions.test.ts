import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  memberships: [] as Array<{
    user_id: string;
    org_id: string;
    role: "owner" | "member";
  }>,
  statusRow: null as {
    api_key_last_four: string | null;
    sending_enabled: boolean;
    test_mode: boolean;
    disconnect_pending_at: string | null;
  } | null,
  statusError: null as { message: string; code?: string } | null,
  statusResponses: [] as Array<{
    data: {
      api_key_last_four: string | null;
      sending_enabled: boolean;
      test_mode: boolean;
      disconnect_pending_at?: string | null;
    } | null;
    error: { message: string; code?: string } | null;
  }>,
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
  getSingleActiveMembership: async () => {
    if (mocks.memberships.length === 0) {
      return { ok: false, reason: "missing" };
    }
    if (mocks.memberships.length !== 1) {
      return { ok: false, reason: "ambiguous" };
    }
    return { ok: true, membership: mocks.memberships[0] };
  },
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
          maybeSingle: async () =>
            mocks.statusResponses.shift() ?? {
              data: mocks.statusRow,
              error: mocks.statusError,
            },
        }),
      }),
    }),
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: mocks.adminUpdate,
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
    mocks.statusResponses.splice(0, mocks.statusResponses.length);
    mocks.validateCredentials.mockResolvedValue({ accountId: "account-1" });
    mocks.saveEsignCredentials.mockResolvedValue(undefined);
    mocks.deleteEsignCredentials.mockResolvedValue(undefined);
    mocks.adminUpdate.mockImplementation(async (fn: string) =>
      fn === "disconnect_org_esign_integration"
        ? {
            data: [
              {
                disconnected: true,
                sending_enabled: false,
                credentials_present: false,
                disconnect_pending: false,
                message: "Dropbox Sign disconnected.",
              },
            ],
            error: null,
          }
        : { error: null },
    );
  });

  it("validates upstream before encrypting and returns only a mask", async () => {
    const result = await connectDropboxSignAction("dropbox-api-key-1234");
    expect(mocks.validateCredentials).toHaveBeenCalledOnce();
    expect(mocks.saveEsignCredentials).toHaveBeenCalledWith({
      orgId: "org-1",
      actorId: "owner-1",
      apiKey: "dropbox-api-key-1234",
      clientId: "client-id",
      providerAccountId: "account-1",
    });
    expect(result).toEqual({
      ok: true,
      data: {
        connected: true,
        canManage: true,
        sendingEnabled: false,
        disconnectPending: false,
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
      error: {
        code: "AUTHORIZATION",
        message: expect.stringMatching(/owners/i),
      },
    });
    expect(mocks.validateCredentials).not.toHaveBeenCalled();
    expect(mocks.saveEsignCredentials).not.toHaveBeenCalled();
  });

  it("fails closed when Dropbox Sign omits the provider account identity", async () => {
    mocks.validateCredentials.mockResolvedValue({ accountId: null });
    const result = await connectDropboxSignAction("dropbox-api-key-1234");
    expect(result).toMatchObject({
      ok: false,
      error: { code: "VALIDATION" },
    });
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
      disconnect_pending_at: null,
    };
    await expect(getEsignConnectionStatus()).resolves.toEqual({
      ok: true,
      data: {
        connected: true,
        canManage: false,
        sendingEnabled: true,
        disconnectPending: false,
        testMode: true,
        apiKeyLastFour: "9876",
      },
    });
  });

  it("treats credentialless disconnect tombstones as disconnected status", async () => {
    mocks.statusRow = {
      api_key_last_four: null,
      sending_enabled: true,
      test_mode: true,
      disconnect_pending_at: null,
    };

    await expect(getEsignConnectionStatus()).resolves.toEqual({
      ok: true,
      data: {
        connected: false,
        canManage: true,
        sendingEnabled: false,
        disconnectPending: false,
        testMode: true,
        apiKeyLastFour: null,
      },
    });
  });

  it("keeps pending disconnect visible without send capability", async () => {
    mocks.statusRow = {
      api_key_last_four: "9876",
      sending_enabled: true,
      test_mode: true,
      disconnect_pending_at: "2026-09-02T12:00:00.000Z",
    };

    await expect(getEsignConnectionStatus()).resolves.toEqual({
      ok: true,
      data: {
        connected: true,
        canManage: true,
        sendingEnabled: false,
        disconnectPending: true,
        testMode: true,
        apiKeyLastFour: "9876",
      },
    });
  });

  it("keeps status deploy-order compatible before the pending column exists", async () => {
    mocks.statusResponses.push(
      {
        data: null,
        error: { message: "column does not exist", code: "42703" },
      },
      {
        data: {
          api_key_last_four: "9876",
          sending_enabled: true,
          test_mode: true,
        },
        error: null,
      },
    );

    await expect(getEsignConnectionStatus()).resolves.toEqual({
      ok: true,
      data: {
        connected: true,
        canManage: true,
        sendingEnabled: true,
        disconnectPending: false,
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
    expect(await setEsignSendingEnabledAction(true, true)).toMatchObject({
      ok: false,
      error: { code: "AUTHORIZATION" },
    });
    expect(await disconnectDropboxSignAction(true)).toMatchObject({
      ok: false,
      error: { code: "AUTHORIZATION" },
    });
    expect(mocks.adminUpdate).not.toHaveBeenCalled();
    expect(mocks.deleteEsignCredentials).not.toHaveBeenCalled();
  });

  it("fails closed when more than one active organization is returned", async () => {
    mocks.memberships.push({
      user_id: "owner-2",
      org_id: "org-0",
      role: "owner",
    });
    const result = await connectDropboxSignAction("dropbox-api-key-1234");
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "AUTHORIZATION",
        message: expect.stringMatching(/single/i),
      },
    });
    expect(mocks.validateCredentials).not.toHaveBeenCalled();
    expect(mocks.saveEsignCredentials).not.toHaveBeenCalled();
  });

  it("never returns upstream provider messages to the browser", async () => {
    mocks.validateCredentials.mockRejectedValue(
      new Error("upstream secret diagnostic and account metadata"),
    );
    const result = await connectDropboxSignAction("dropbox-api-key-1234");
    expect(result).toEqual({
      ok: false,
      error: {
        code: "ESIGN_CONNECT_FAILED",
        message: "Dropbox Sign could not be connected.",
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret diagnostic");
  });

  it("fails safely when sending is toggled without a connection row", async () => {
    mocks.adminUpdate.mockResolvedValue({
      error: { message: "not found", code: "P0002" },
    });
    const result = await setEsignSendingEnabledAction(true, true);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "DATABASE",
        message: "Connect Dropbox Sign before enabling sending.",
      },
    });
  });

  it("explains that callback verification is required before sending", async () => {
    mocks.adminUpdate.mockResolvedValue({
      error: { message: "constraint detail", code: "23514" },
    });
    const result = await setEsignSendingEnabledAction(true, true);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "DATABASE",
        message: "Verify the Dropbox Sign callback before enabling sending.",
      },
    });
  });

  it("explains pending disconnect before sending can be re-enabled", async () => {
    mocks.adminUpdate.mockResolvedValue({
      error: {
        message:
          "Finish active eSign work before re-enabling Dropbox Sign sending",
        code: "23514",
      },
    });
    const result = await setEsignSendingEnabledAction(true, true);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "DATABASE",
        message:
          "Finish active eSign work before re-enabling Dropbox Sign sending.",
      },
    });
  });

  it("uses the owner-gated database boundary and sanitizes unexpected failures", async () => {
    mocks.adminUpdate.mockResolvedValue({
      error: { message: "private database diagnostic", code: "XX000" },
    });
    const result = await setEsignSendingEnabledAction(true, true);
    expect(mocks.adminUpdate).toHaveBeenCalledWith(
      "set_org_esign_sending_enabled",
      {
        p_org_id: "org-1",
        p_actor_id: "owner-1",
        p_enabled: true,
      },
    );
    expect(result).toEqual({
      ok: false,
      error: {
        code: "DATABASE",
        message: "Dropbox Sign sending could not be updated.",
      },
    });
    expect(JSON.stringify(result)).not.toContain("private database diagnostic");
  });

  it.each([false, undefined])(
    "rejects a sending change unless operator confirmation is literally true (%s)",
    async (operatorConfirmed) => {
      const result = await setEsignSendingEnabledAction(
        true,
        operatorConfirmed as boolean,
      );

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "VALIDATION",
          message: expect.stringMatching(/confirm/i),
        },
      });
      expect(mocks.adminUpdate).not.toHaveBeenCalled();
      expect(mocks.revalidatePath).not.toHaveBeenCalled();
    },
  );

  it("allows a confirmed disable through the same database-only boundary", async () => {
    await expect(setEsignSendingEnabledAction(false, true)).resolves.toEqual({
      ok: true,
      data: null,
    });
    expect(mocks.adminUpdate).toHaveBeenCalledWith(
      "set_org_esign_sending_enabled",
      {
        p_org_id: "org-1",
        p_actor_id: "owner-1",
        p_enabled: false,
      },
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/settings/integrations");
  });

  it.each([false, undefined])(
    "rejects disconnect unless operator confirmation is literally true (%s)",
    async (operatorConfirmed) => {
      const result = await disconnectDropboxSignAction(
        operatorConfirmed as boolean,
      );

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "VALIDATION",
          message: expect.stringMatching(/confirm/i),
        },
      });
      expect(mocks.deleteEsignCredentials).not.toHaveBeenCalled();
      expect(mocks.revalidatePath).not.toHaveBeenCalled();
      expect(mocks.adminUpdate).not.toHaveBeenCalled();
    },
  );

  it("passes the owner identity into fail-closed disconnect", async () => {
    await expect(disconnectDropboxSignAction(true)).resolves.toEqual({
      ok: true,
      data: {
        disconnected: true,
        sendingEnabled: false,
        credentialsPresent: false,
        disconnectPending: false,
        message: "Dropbox Sign disconnected.",
      },
    });
    expect(mocks.adminUpdate).toHaveBeenCalledWith(
      "disconnect_org_esign_integration",
      {
        p_org_id: "org-1",
        p_actor_id: "owner-1",
      },
    );
    expect(mocks.deleteEsignCredentials).not.toHaveBeenCalled();
  });

  it("reports the atomic disconnect state returned by the database", async () => {
    mocks.adminUpdate.mockResolvedValueOnce({
      data: [
        {
          disconnected: false,
          sending_enabled: false,
          credentials_present: true,
          disconnect_pending: true,
          message:
            "Dropbox Sign sending is off. Active eSign work remains: 1 signature request. Callback ingestion and read credentials are preserved until the active work reaches a terminal state. Manage templates and new sends stay blocked.",
        },
      ],
      error: null,
    });

    await expect(disconnectDropboxSignAction(true)).resolves.toEqual({
      ok: true,
      data: {
        disconnected: false,
        sendingEnabled: false,
        credentialsPresent: true,
        disconnectPending: true,
        message:
          "Dropbox Sign sending is off. Active eSign work remains: 1 signature request. Callback ingestion and read credentials are preserved until the active work reaches a terminal state. Manage templates and new sends stay blocked.",
      },
    });
    expect(mocks.adminUpdate).toHaveBeenCalledWith(
      "disconnect_org_esign_integration",
      {
        p_org_id: "org-1",
        p_actor_id: "owner-1",
      },
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/settings/integrations");
  });

  it("surfaces an unconfirmed disconnect state instead of reporting from a local flag", async () => {
    mocks.adminUpdate.mockResolvedValueOnce({
      data: [
        {
          disconnected: false,
          sending_enabled: true,
          credentials_present: true,
          disconnect_pending: false,
          message: "Dropbox Sign stayed connected.",
        },
      ],
      error: null,
    });

    await expect(disconnectDropboxSignAction(true)).resolves.toEqual({
      ok: true,
      data: {
        disconnected: false,
        sendingEnabled: true,
        credentialsPresent: true,
        disconnectPending: false,
        message: "Dropbox Sign stayed connected.",
      },
    });
  });

  it("fails closed if the atomic disconnect RPC has not deployed yet", async () => {
    mocks.adminUpdate.mockResolvedValueOnce({
      data: null,
      error: { message: "function not found", code: "42883" },
    });

    await expect(disconnectDropboxSignAction(true)).resolves.toEqual({
      ok: false,
      error: {
        code: "DATABASE",
        message:
          "Dropbox Sign disconnect requires the latest database migration.",
      },
    });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
    expect(mocks.deleteEsignCredentials).not.toHaveBeenCalled();
  });
});
