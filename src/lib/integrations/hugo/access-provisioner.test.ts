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
const REQUEST_HASH = "a".repeat(64);

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    operation_id: OPERATION_ID,
    app_id: "sandra",
    request_hash: REQUEST_HASH,
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

function preflight(
  overrides: Record<string, unknown> = {},
) {
  return {
    proceed: true,
    request_hash: REQUEST_HASH,
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
    mocks.rpc
      .mockResolvedValueOnce({ data: preflight(), error: null })
      .mockResolvedValueOnce({ data: receipt(), error: null });

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
    expect(mocks.rpc).toHaveBeenNthCalledWith(1, "hugo_preflight_access_operation", {
      p_operation_id: OPERATION_ID,
      p_email: "member@bmhgroupkc.com",
      p_role: "member",
      p_config: { timezone: "America/Chicago" },
      p_status: "active",
      p_access_expires_at: null,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, "hugo_apply_access", {
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
      .mockResolvedValueOnce({ data: preflight(), error: null })
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
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, "hugo_preflight_access_operation", {
      p_operation_id: OPERATION_ID,
      p_email: "owner@bmhgroupkc.com",
      p_role: "owner",
      p_config: { timezone: "America/Chicago" },
      p_status: "suspended",
      p_access_expires_at: null,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(3, "hugo_apply_access", {
      p_operation_id: OPERATION_ID,
      p_email: "owner@bmhgroupkc.com",
      p_role: "owner",
      p_config: { timezone: "America/Chicago" },
      p_status: "suspended",
      p_access_expires_at: null,
    });
  });

  it("preserves an exact successful replay and surfaces a bounded hash conflict", async () => {
    const successfulReplay = receipt({
      requested: { role: "member", config: {}, status: "suspended", access_expires_at: null },
    });
    mocks.rpc
      .mockResolvedValueOnce({ data: preflight(), error: null })
      .mockResolvedValueOnce({ data: successfulReplay, error: null })
      .mockResolvedValueOnce({
        data: preflight({ proceed: false, receipt: successfulReplay }),
        error: null,
      })
      .mockResolvedValueOnce({
        data: preflight({
          proceed: false,
          receipt: receipt({
            requested: { role: "owner", config: {}, status: "suspended", access_expires_at: null },
            ok: false,
            error_code: "OPERATION_CONFLICT",
            error_message: "Operation id was already used with a different request.",
          }),
        }),
        error: null,
      });

    const base = {
      operationId: OPERATION_ID,
      email: "member@bmhgroupkc.com",
      role: "member" as const,
      config: {},
      status: "suspended" as const,
    };
    const first = await applyHugoAccess(base);
    const exactReplay = await applyHugoAccess(base);
    const mismatchedReplay = await applyHugoAccess({ ...base, role: "owner" });

    expect(first).toMatchObject({ ok: true, request_hash: REQUEST_HASH });
    expect(exactReplay).toEqual(first);
    expect(mismatchedReplay).toMatchObject({
      ok: false,
      error_code: "OPERATION_CONFLICT",
      error_message: "Sandra provisioner rejected this request.",
    });
    expect(mismatchedReplay.error_message).not.toContain("different request");
  });

  it("preserves an exact failed replay and rejects a changed failed payload", async () => {
    const failure = receipt({
      requested: { role: "member", config: {}, status: "suspended", access_expires_at: null },
      ok: false,
      error_code: "IDENTITY_NOT_FOUND",
      error_message: "Sandra identity was not found for this email.",
    });
    mocks.rpc
      .mockResolvedValueOnce({ data: preflight(), error: null })
      .mockResolvedValueOnce({ data: failure, error: null })
      .mockResolvedValueOnce({
        data: preflight({ proceed: false, receipt: failure }),
        error: null,
      })
      .mockResolvedValueOnce({
        data: preflight({
          proceed: false,
          receipt: receipt({
            requested: { role: "member", config: { cohort: "other" }, status: "suspended", access_expires_at: null },
            ok: false,
            error_code: "OPERATION_CONFLICT",
            error_message: "Operation id was already used with a different request.",
          }),
        }),
        error: null,
      });

    const base = {
      operationId: OPERATION_ID,
      email: "member@bmhgroupkc.com",
      role: "member" as const,
      config: {},
      status: "suspended" as const,
    };
    const first = await applyHugoAccess(base);
    const exactReplay = await applyHugoAccess(base);
    const mismatchedReplay = await applyHugoAccess({ ...base, config: { cohort: "other" } });

    expect(first).toMatchObject({ ok: false, error_code: "IDENTITY_NOT_FOUND", request_hash: REQUEST_HASH });
    expect(exactReplay).toEqual(first);
    expect(mismatchedReplay).toMatchObject({ ok: false, error_code: "OPERATION_CONFLICT" });
    expect(mismatchedReplay.error_message).not.toContain("different request");
  });

  it.each(["api_token", "apiKey", "api_key", "credential", "region"])(
    "hash-binds non-contract config key %s before any Auth mutation",
    async (key) => {
      const invalid = receipt({
        app_user_id: null,
        requested: {
          role: "member",
          config: {},
          status: "active",
          access_expires_at: null,
        },
        ok: false,
        error_code: "INVALID_CONFIG",
        error_message: "Sandra access configuration is invalid.",
      });
      mocks.rpc.mockResolvedValueOnce({
        data: preflight({ proceed: false, receipt: invalid }),
        error: null,
      });
      const result = await applyHugoAccess({
        operationId: OPERATION_ID,
        email: "member@bmhgroupkc.com",
        role: "member",
        config: { [key]: "must-never-leave-this-process" },
        status: "active",
      });

      expect(result).toMatchObject({
        ok: false,
        error_code: "INVALID_CONFIG",
        error_message: expect.not.stringContaining("must-never"),
      });
      expect(mocks.rpc).toHaveBeenCalledWith(
        "hugo_preflight_access_operation",
        {
          p_operation_id: OPERATION_ID,
          p_email: "member@bmhgroupkc.com",
          p_role: "member",
          p_config: { [key]: "must-never-leave-this-process" },
          p_status: "active",
          p_access_expires_at: null,
        },
      );
      expect(mocks.createUser).not.toHaveBeenCalled();
    },
  );

  it("rejects non-BMH domains before creating a local identity", async () => {
    const invalid = receipt({
      app_user_id: null,
      requested: {
        role: "member",
        config: {},
        status: "active",
        access_expires_at: null,
      },
      ok: false,
      error_code: "INVALID_DOMAIN",
      error_message: "Sandra access is limited to the BMH Group email domain.",
    });
    mocks.rpc.mockResolvedValueOnce({
      data: preflight({ proceed: false, receipt: invalid }),
      error: null,
    });
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
    expect(mocks.rpc).toHaveBeenCalledWith(
      "hugo_preflight_access_operation",
      {
        p_operation_id: OPERATION_ID,
        p_email: "outsider@example.com",
        p_role: "member",
        p_config: {},
        p_status: "active",
        p_access_expires_at: null,
      },
    );
  });

  it.each([
    {
      name: "malformed email",
      email: "not-an-email",
      role: "member",
      errorCode: "INVALID_EMAIL",
      safeRole: "member",
    },
    {
      name: "unknown role",
      email: "member@bmhgroupkc.com",
      role: "superadmin",
      errorCode: "INVALID_ROLE",
      safeRole: null,
    },
  ])("hash-binds $name without retaining the invalid role", async ({
    email,
    role,
    errorCode,
    safeRole,
  }) => {
    const invalid = receipt({
      app_user_id: null,
      requested: {
        role: safeRole,
        config: {},
        status: "active",
        access_expires_at: null,
      },
      ok: false,
      error_code: errorCode,
      error_message: "Sandra rejected the invalid access request.",
    });
    mocks.rpc.mockResolvedValueOnce({
      data: preflight({ proceed: false, receipt: invalid }),
      error: null,
    });

    const result = await applyHugoAccess({
      operationId: OPERATION_ID,
      email,
      role: role as "member",
      status: "active",
    });

    expect(result).toMatchObject({
      ok: false,
      error_code: errorCode,
      requested: { role: safeRole },
    });
    expect(JSON.stringify(result)).not.toContain("superadmin");
    expect(mocks.rpc).toHaveBeenCalledWith(
      "hugo_preflight_access_operation",
      {
        p_operation_id: OPERATION_ID,
        p_email: email,
        p_role: role,
        p_config: {},
        p_status: "active",
        p_access_expires_at: null,
      },
    );
    expect(mocks.createUser).not.toHaveBeenCalled();
  });

  it("replays an exact invalid request and blocks changed reuse without creating Auth users", async () => {
    const invalid = receipt({
      app_user_id: null,
      requested: {
        role: "member",
        config: {},
        status: "active",
        access_expires_at: null,
      },
      ok: false,
      error_code: "INVALID_CONFIG",
      error_message: "Sandra access configuration is invalid.",
    });
    const conflict = receipt({
      app_user_id: null,
      requested: {
        role: "member",
        config: {},
        status: "active",
        access_expires_at: null,
      },
      ok: false,
      error_code: "OPERATION_CONFLICT",
      error_message: "Operation id was already used with a different request.",
    });
    mocks.rpc
      .mockResolvedValueOnce({
        data: preflight({ proceed: false, receipt: invalid }),
        error: null,
      })
      .mockResolvedValueOnce({
        data: preflight({ proceed: false, receipt: invalid }),
        error: null,
      })
      .mockResolvedValueOnce({
        data: preflight({ proceed: false, receipt: conflict }),
        error: null,
      });

    const base = {
      operationId: OPERATION_ID,
      email: "member@bmhgroupkc.com",
      role: "member" as const,
      config: { api_token: "first-secret" },
      status: "active" as const,
    };
    const first = await applyHugoAccess(base);
    const exact = await applyHugoAccess(base);
    const changed = await applyHugoAccess({
      ...base,
      config: { api_token: "second-secret" },
    });

    expect(first).toMatchObject({
      ok: false,
      error_code: "INVALID_CONFIG",
      request_hash: REQUEST_HASH,
      requested: { config: {} },
    });
    expect(exact).toEqual(first);
    expect(changed).toMatchObject({
      ok: false,
      error_code: "OPERATION_CONFLICT",
      request_hash: REQUEST_HASH,
      requested: { config: {} },
    });
    expect(JSON.stringify([first, exact, changed])).not.toContain(
      "first-secret",
    );
    expect(JSON.stringify([first, exact, changed])).not.toContain(
      "second-secret",
    );
    expect(mocks.createUser).not.toHaveBeenCalled();
    expect(mocks.listUsers).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledTimes(3);
  });

  it("durably records an Auth identity failure and binds its exact and changed retries", async () => {
    const identityFailure = receipt({
      app_user_id: null,
      ok: false,
      error_code: "IDENTITY_PROVISION_FAILED",
      error_message: "Sandra identity could not be provisioned.",
    });
    mocks.rpc
      .mockResolvedValueOnce({ data: preflight(), error: null })
      .mockResolvedValueOnce({ data: identityFailure, error: null })
      .mockResolvedValueOnce({
        data: preflight({ proceed: false, receipt: identityFailure }),
        error: null,
      })
      .mockResolvedValueOnce({
        data: preflight({
          proceed: false,
          receipt: receipt({
            app_user_id: null,
            requested: {
              role: "owner",
              config: { timezone: "America/Chicago" },
              status: "active",
              access_expires_at: null,
            },
            ok: false,
            error_code: "OPERATION_CONFLICT",
            error_message: "Operation id was already used with a different request.",
          }),
        }),
        error: null,
      });
    mocks.listUsers.mockResolvedValue({
      data: {
        users: [
          { id: USER_ID, email: "member@bmhgroupkc.com" },
          { id: "33333333-3333-4333-8333-333333333333", email: "MEMBER@BMHGROUPKC.COM" },
        ],
      },
      error: null,
    });

    const request = {
      operationId: OPERATION_ID,
      email: "member@bmhgroupkc.com",
      role: "member" as const,
      config: { timezone: "America/Chicago" },
      status: "active" as const,
    };
    const result = await applyHugoAccess(request);
    const exactRetry = await applyHugoAccess(request);
    const changedRetry = await applyHugoAccess({ ...request, role: "owner" });

    expect(result).toMatchObject({
      ok: false,
      error_code: "IDENTITY_PROVISION_FAILED",
      request_hash: REQUEST_HASH,
    });
    expect(exactRetry).toEqual(result);
    expect(changedRetry).toMatchObject({
      ok: false,
      error_code: "OPERATION_CONFLICT",
      request_hash: REQUEST_HASH,
    });
    expect(result.error_message).not.toContain("33333333");
    expect(mocks.listUsers).toHaveBeenCalledOnce();
    expect(mocks.rpc).toHaveBeenNthCalledWith(
      1,
      "hugo_preflight_access_operation",
      expect.any(Object),
    );
    expect(mocks.rpc).toHaveBeenNthCalledWith(
      2,
      "hugo_record_identity_provision_failure",
      {
        p_operation_id: OPERATION_ID,
        p_email: "member@bmhgroupkc.com",
        p_role: "member",
        p_config: { timezone: "America/Chicago" },
        p_status: "active",
        p_access_expires_at: null,
      },
    );
  });

  it("lets the database reconcile an Auth create that committed after its response was lost", async () => {
    const reconciled = receipt({
      app_user_id: USER_ID,
      ok: true,
      error_code: null,
      error_message: null,
    });
    mocks.rpc
      .mockResolvedValueOnce({ data: preflight(), error: null })
      .mockResolvedValueOnce({ data: reconciled, error: null });
    mocks.listUsers
      .mockResolvedValueOnce({ data: { users: [] }, error: null })
      .mockRejectedValueOnce(new Error("Auth re-read response was lost"));
    mocks.createUser.mockResolvedValueOnce({
      data: { user: null },
      error: { message: "Auth create response was lost" },
    });

    const result = await applyHugoAccess({
      operationId: OPERATION_ID,
      email: "member@bmhgroupkc.com",
      role: "member",
      config: { timezone: "America/Chicago" },
      status: "active",
    });

    expect(result).toMatchObject({
      ok: true,
      app_user_id: USER_ID,
      request_hash: REQUEST_HASH,
    });
    expect(mocks.listUsers).toHaveBeenCalledTimes(2);
    expect(mocks.createUser).toHaveBeenCalledOnce();
    expect(mocks.rpc).toHaveBeenNthCalledWith(
      2,
      "hugo_record_identity_provision_failure",
      {
        p_operation_id: OPERATION_ID,
        p_email: "member@bmhgroupkc.com",
        p_role: "member",
        p_config: { timezone: "America/Chicago" },
        p_status: "active",
        p_access_expires_at: null,
      },
    );
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "hugo_apply_access",
      expect.any(Object),
    );
  });

  it("returns an operation conflict before creating a changed active identity", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: preflight({
        proceed: false,
        receipt: receipt({
          ok: false,
          error_code: "OPERATION_CONFLICT",
          error_message: "Operation id was already used with a different request.",
        }),
      }),
      error: null,
    });

    const result = await applyHugoAccess({
      operationId: OPERATION_ID,
      email: "changed@bmhgroupkc.com",
      role: "member",
      config: {},
      status: "active",
    });

    expect(result).toMatchObject({
      ok: false,
      error_code: "OPERATION_CONFLICT",
      request_hash: REQUEST_HASH,
    });
    expect(mocks.createUser).not.toHaveBeenCalled();
    expect(mocks.listUsers).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledOnce();
  });

  it("fails closed when a mutating RPC returns a receipt without request binding", async () => {
    const unbound = { ...receipt(), request_hash: undefined };
    mocks.rpc
      .mockResolvedValueOnce({ data: preflight(), error: null })
      .mockResolvedValueOnce({ data: unbound, error: null });

    const result = await suspendHugoAccess({
      operationId: OPERATION_ID,
      email: "member@bmhgroupkc.com",
      role: "member",
      config: {},
    });

    expect(result).toMatchObject({
      ok: false,
      error_code: "INVALID_RECEIPT",
    });
  });

  it("fails closed when apply returns a different request hash than preflight", async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: preflight(), error: null })
      .mockResolvedValueOnce({
        data: receipt({ request_hash: "b".repeat(64) }),
        error: null,
      });

    const result = await applyHugoAccess({
      operationId: OPERATION_ID,
      email: "member@bmhgroupkc.com",
      role: "member",
      config: {},
      status: "suspended",
    });

    expect(result).toMatchObject({
      ok: false,
      error_code: "INVALID_RECEIPT",
    });
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

  it("lets the SQL identity connector own the Auth deletion", async () => {
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
    expect(mocks.listUsers).not.toHaveBeenCalled();
    expect(mocks.deleteUser).not.toHaveBeenCalled();
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
