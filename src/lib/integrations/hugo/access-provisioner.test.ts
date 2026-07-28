import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  rpc: vi.fn(),
  listUsers: vi.fn(),
  createUser: vi.fn(),
  deleteUser: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: mocks.createAdminClient,
}));

import {
  applyHugoAccess,
  deleteHugoIdentity,
  hugoAccessProvisioner,
  inspectHugoAccess,
  listHugoAccess,
  suspendHugoAccess,
} from "./access-provisioner";

const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    operation_id: OPERATION_ID,
    app_id: "sandra",
    app_user_id: USER_ID,
    requested: {
      role: "member",
      config: { timezone: "America/Chicago" },
      status: "active",
      access_expires_at: null,
    },
    observed: {
      role: "member",
      config: { timezone: "America/Chicago" },
      status: "active",
      access_expires_at: null,
      has_durable_activity: false,
    },
    ok: true,
    error_code: null,
    error_message: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createAdminClient.mockReturnValue({
    rpc: mocks.rpc,
    auth: {
      admin: {
        listUsers: mocks.listUsers,
        createUser: mocks.createUser,
        deleteUser: mocks.deleteUser,
      },
    },
  });
  mocks.listUsers.mockResolvedValue({ data: { users: [] }, error: null });
  mocks.createUser.mockResolvedValue({
    data: { user: { id: USER_ID, email: "member@bmhgroupkc.com" } },
    error: null,
  });
  mocks.deleteUser.mockResolvedValue({ error: null });
});
describe("Sandra Hugo access provisioner", () => {
  it("creates the exact local identity and sends the frozen apply RPC shape", async () => {
    mocks.rpc.mockResolvedValue({ data: receipt(), error: null });

    const result = await applyHugoAccess({
      operationId: OPERATION_ID,
      email: " Member@BMHGROUPKC.COM ",
      role: "member",
      config: { timezone: "America/Chicago" },
      status: "active",
      accessExpiresAt: null,
    });

    expect(result.ok).toBe(true);
    expect(mocks.createUser).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "member@bmhgroupkc.com",
        email_confirm: true,
        app_metadata: { provisioning_origin: "hugo" },
      }),
    );
    expect(mocks.rpc).toHaveBeenCalledWith("hugo_apply_access", {
      p_operation_id: OPERATION_ID,
      p_email: "member@bmhgroupkc.com",
      p_role: "member",
      p_config: { timezone: "America/Chicago" },
      p_status: "active",
      p_access_expires_at: null,
    });
  });

  it("does not create an identity while suspending an existing grant", async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: receipt({
          observed: {
            role: "owner",
            config: { timezone: "America/Chicago" },
            status: "active",
            access_expires_at: null,
            has_durable_activity: false,
          },
        }),
        error: null,
      })
      .mockResolvedValueOnce({ data: receipt({ ok: true }), error: null });

    const result = await suspendHugoAccess({
      operationId: OPERATION_ID,
      email: "owner@bmhgroupkc.com",
    });

    expect(result.ok).toBe(true);
    expect(mocks.createUser).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenNthCalledWith(1, "hugo_inspect_access", {
      p_email: "owner@bmhgroupkc.com",
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, "hugo_apply_access", {
      p_operation_id: OPERATION_ID,
      p_email: "owner@bmhgroupkc.com",
      p_role: "owner",
      p_config: { timezone: "America/Chicago" },
      p_status: "suspended",
      p_access_expires_at: null,
    });
  });

  it("rejects credential-shaped config before it reaches PostgREST", async () => {
    const result = await applyHugoAccess({
      operationId: OPERATION_ID,
      email: "member@bmhgroupkc.com",
      role: "member",
      config: { api_token: "must-never-leave-this-process" },
      status: "active",
    });

    expect(result).toMatchObject({
      ok: false,
      error_code: "INVALID_CONFIG",
      error_message: expect.not.stringContaining("must-never"),
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.createUser).not.toHaveBeenCalled();
  });

  it("rejects non-BMH domains before creating a local identity", async () => {
    const result = await applyHugoAccess({
      operationId: OPERATION_ID,
      email: "outsider@example.com",
      role: "member",
      status: "active",
    });

    expect(result).toMatchObject({
      ok: false,
      error_code: "INVALID_DOMAIN",
    });
    expect(mocks.createUser).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("fails closed when Auth returns duplicate identities for an email", async () => {
    mocks.listUsers.mockResolvedValue({
      data: {
        users: [
          { id: USER_ID, email: "member@bmhgroupkc.com" },
          { id: "33333333-3333-4333-8333-333333333333", email: "MEMBER@BMHGROUPKC.COM" },
        ],
      },
      error: null,
    });

    const result = await applyHugoAccess({
      operationId: OPERATION_ID,
      email: "member@bmhgroupkc.com",
      role: "member",
      status: "active",
    });

    expect(result).toMatchObject({
      ok: false,
      error_code: "IDENTITY_PROVISION_FAILED",
    });
    expect(result.error_message).not.toContain("33333333");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("surfaces inspect receipts without inventing local state", async () => {
    mocks.rpc.mockResolvedValue({
      data: receipt({
        app_user_id: null,
        observed: {
          role: null,
          config: {},
          status: "missing",
          access_expires_at: null,
          has_durable_activity: false,
        },
      }),
      error: null,
    });

    const result = await inspectHugoAccess("missing@bmhgroupkc.com");
    expect(result.observed.status).toBe("missing");
    expect(mocks.rpc).toHaveBeenCalledWith("hugo_inspect_access", {
      p_email: "missing@bmhgroupkc.com",
    });
  });

  it("lists deterministic sanitized access inventory without creating identities", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        {
          email: "Zed@BMHGROUPKC.COM",
          app_user_id: "33333333-3333-4333-8333-333333333333",
          role: "member",
          config: { timezone: "America/Chicago", api_token: "must-not-leak" },
          status: "active",
          access_expires_at: null,
          has_durable_activity: true,
        },
        {
          email: "alice@bmhgroupkc.com",
          app_user_id: USER_ID,
          role: "owner",
          config: { timezone: "America/Chicago" },
          status: "suspended",
          access_expires_at: "2026-08-01T00:00:00.000Z",
          has_durable_activity: false,
        },
      ],
      error: null,
    });

    const result = await listHugoAccess();

    expect(result).toEqual([
      expect.objectContaining({
        email: "alice@bmhgroupkc.com",
        status: "suspended",
        has_durable_activity: false,
      }),
      expect.objectContaining({
        email: "zed@bmhgroupkc.com",
        config: {},
        has_durable_activity: true,
      }),
    ]);
    expect(mocks.createUser).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledWith("hugo_list_access", {});
  });

  it("sanitizes inventory RPC failures instead of exposing provider details", async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { message: "service_role=super-secret provider detail" },
    });

    await expect(listHugoAccess()).rejects.toThrow("Sandra access inventory failed.");
    await expect(listHugoAccess()).rejects.not.toThrow("super-secret");
  });

  it("deletes Auth only after the SQL identity connector succeeds", async () => {
    mocks.listUsers.mockResolvedValue({
      data: { users: [{ id: USER_ID, email: "member@bmhgroupkc.com" }] },
      error: null,
    });
    mocks.rpc.mockResolvedValue({
      data: receipt({
        observed: {
          role: null,
          config: {},
          status: "missing",
          access_expires_at: null,
          has_durable_activity: false,
        },
      }),
      error: null,
    });

    const result = await deleteHugoIdentity({
      operationId: OPERATION_ID,
      email: "member@bmhgroupkc.com",
    });

    expect(result.ok).toBe(true);
    expect(mocks.rpc).toHaveBeenCalledWith("hugo_delete_identity", {
      p_operation_id: OPERATION_ID,
      p_email: "member@bmhgroupkc.com",
    });
    expect(mocks.deleteUser).toHaveBeenCalledWith(USER_ID);
  });

  it("exports the complete frozen lifecycle surface", () => {
    expect(Object.keys(hugoAccessProvisioner)).toEqual([
      "grant",
      "suspend",
      "reactivate",
      "revoke",
      "inspect",
      "list",
      "preparePristineDelete",
      "deleteIdentity",
    ]);
  });
});
