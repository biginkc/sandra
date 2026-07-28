import { randomUUID } from "node:crypto";

import { createAdminClient } from "@/lib/supabase/admin";

export const SANDRA_HUGO_APP_ID = "sandra" as const;
export const SANDRA_HUGO_ROLES = ["owner", "member"] as const;
export type SandraHugoRole = (typeof SANDRA_HUGO_ROLES)[number];
export type SandraHugoStatus = "active" | "suspended" | "revoked";

export type ProvisionerReceipt = {
  operation_id: string;
  app_id: typeof SANDRA_HUGO_APP_ID;
  app_user_id: string | null;
  requested: {
    role: string | null;
    config: Record<string, unknown>;
    status: SandraHugoStatus;
    access_expires_at: string | null;
  };
  observed: {
    role: string | null;
    config: Record<string, unknown>;
    status: SandraHugoStatus | "missing";
    access_expires_at: string | null;
    has_durable_activity: boolean | null;
  };
  ok: boolean;
  error_code: string | null;
  error_message: string | null;
};

type HugoConfig = Record<string, unknown>;

type RpcClient = {
  rpc(
    fn: "hugo_apply_access",
    args: {
      p_operation_id: string;
      p_email: string;
      p_role: SandraHugoRole;
      p_config: HugoConfig;
      p_status: SandraHugoStatus;
      p_access_expires_at: string | null;
    },
  ): Promise<{ data: unknown; error: { message: string; code?: string } | null }>;
  rpc(
    fn: "hugo_inspect_access",
    args: { p_email: string },
  ): Promise<{ data: unknown; error: { message: string; code?: string } | null }>;
  rpc(
    fn: "hugo_prepare_pristine_delete",
    args: { p_operation_id: string; p_email: string },
  ): Promise<{ data: unknown; error: { message: string; code?: string } | null }>;
  rpc(
    fn: "hugo_delete_identity",
    args: { p_operation_id: string; p_email: string },
  ): Promise<{ data: unknown; error: { message: string; code?: string } | null }>;
};

type AuthUser = { id: string; email?: string | null };
type AuthAdmin = {
  auth: {
    admin: {
      listUsers(options?: { page?: number; perPage?: number }): Promise<{
        data: { users: AuthUser[] };
        error: { message: string } | null;
      }>;
      createUser(input: {
        email: string;
        email_confirm: boolean;
        app_metadata?: Record<string, unknown>;
      }): Promise<{
        data: { user: AuthUser | null };
        error: { message: string } | null;
      }>;
      deleteUser(userId: string): Promise<{ error: { message: string } | null }>;
    };
  };
};

const USER_PAGE_SIZE = 200;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SECRET_KEY_PATTERN =
  /(?:secret|token|password|passwd|private[_-]?key|access[_-]?key|authorization|cookie)/i;

function rpcClient(): RpcClient {
  return createAdminClient() as unknown as RpcClient;
}

function normalizedEmail(email: string): string {
  return email.trim().toLowerCase();
}

function safeConfig(value: unknown): HugoConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const walk = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(walk);
    if (!input || typeof input !== "object") return input;
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(input)) {
      if (SECRET_KEY_PATTERN.test(key)) return null;
      const next = walk(child);
      if (next === null && child !== null) return null;
      output[key] = next;
    }
    return output;
  };
  const result = walk(value);
  return result && typeof result === "object" && !Array.isArray(result)
    ? (result as HugoConfig)
    : null;
}

function validOperationId(operationId: string): boolean {
  return UUID_PATTERN.test(operationId);
}

function failureReceipt(input: {
  operationId: string;
  role?: SandraHugoRole | null;
  config?: HugoConfig;
  status: SandraHugoStatus;
  expiresAt?: string | null;
  code: string;
  message: string;
  appUserId?: string | null;
}): ProvisionerReceipt {
  return {
    operation_id: input.operationId,
    app_id: SANDRA_HUGO_APP_ID,
    app_user_id: input.appUserId ?? null,
    requested: {
      role: input.role ?? null,
      config: input.config ?? {},
      status: input.status,
      access_expires_at: input.expiresAt ?? null,
    },
    observed: {
      role: null,
      config: {},
      status: "missing",
      access_expires_at: null,
      has_durable_activity: null,
    },
    ok: false,
    error_code: input.code,
    error_message: input.message,
  };
}

function parseReceipt(
  data: unknown,
  fallback: Parameters<typeof failureReceipt>[0],
): ProvisionerReceipt {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return failureReceipt({
      ...fallback,
      code: "INVALID_RECEIPT",
      message: "Sandra returned an invalid provisioner receipt.",
    });
  }
  const receipt = data as Partial<ProvisionerReceipt>;
  if (
    typeof receipt.operation_id !== "string" ||
    receipt.app_id !== SANDRA_HUGO_APP_ID ||
    !receipt.requested ||
    !receipt.observed ||
    typeof receipt.ok !== "boolean"
  ) {
    return failureReceipt({
      ...fallback,
      code: "INVALID_RECEIPT",
      message: "Sandra returned an invalid provisioner receipt.",
    });
  }
  const requested = receipt.requested as ProvisionerReceipt["requested"];
  const observed = receipt.observed as ProvisionerReceipt["observed"];
  return {
    ...(receipt as ProvisionerReceipt),
    requested: {
      ...requested,
      config: safeConfig(requested.config) ?? {},
    },
    observed: {
      ...observed,
      config: safeConfig(observed.config) ?? {},
    },
    error_message: receipt.error_message
      ? "Sandra provisioner rejected this request."
      : null,
  };
}

async function findExactUser(
  admin: AuthAdmin,
  email: string,
): Promise<AuthUser | null> {
  const seen = new Set<string>();
  for (let page = 1; page <= 100; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage: USER_PAGE_SIZE,
    });
    if (error) throw new Error("Sandra identity lookup failed.");
    const exact = data.users.find(
      (candidate) => normalizedEmail(candidate.email ?? "") === email,
    );
    if (exact) return exact;
    if (data.users.length < USER_PAGE_SIZE) return null;
    const fingerprint = data.users.map((candidate) => candidate.id).join(":");
    if (seen.has(fingerprint)) throw new Error("Sandra identity lookup repeated a page.");
    seen.add(fingerprint);
  }
  throw new Error("Sandra identity lookup exceeded the supported page limit.");
}

async function ensureLocalIdentity(email: string): Promise<AuthUser> {
  const admin = createAdminClient() as unknown as AuthAdmin;
  const existing = await findExactUser(admin, email);
  if (existing) return existing;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    app_metadata: { provisioning_origin: "hugo" },
  });
  if (data.user) return data.user;
  // A concurrent Hugo grant can win the Auth insert. Re-read the exact email
  // instead of creating a second identity or deleting an ambiguous result.
  const raced = await findExactUser(admin, email);
  if (raced) return raced;
  throw new Error(error ? "Sandra identity creation failed." : "Sandra identity was not returned.");
}

async function callRpc(
  fn: "hugo_apply_access" | "hugo_inspect_access" | "hugo_prepare_pristine_delete" | "hugo_delete_identity",
  args: Record<string, unknown>,
  fallback: Parameters<typeof failureReceipt>[0],
): Promise<ProvisionerReceipt> {
  try {
    const result = await (rpcClient() as unknown as {
      rpc(name: string, input: Record<string, unknown>): Promise<{
        data: unknown;
        error: { message: string; code?: string } | null;
      }>;
    }).rpc(fn, args);
    if (result.error) {
      return failureReceipt({
        ...fallback,
        code: "PROVISIONER_RPC_FAILED",
        message: "Sandra could not apply the requested access change.",
      });
    }
    return parseReceipt(result.data, fallback);
  } catch {
    return failureReceipt({
      ...fallback,
      code: "PROVISIONER_RPC_FAILED",
      message: "Sandra could not apply the requested access change.",
    });
  }
}

export type ApplyHugoAccessInput = {
  operationId?: string;
  email: string;
  role: SandraHugoRole;
  config?: HugoConfig;
  status: SandraHugoStatus;
  accessExpiresAt?: string | null;
};

export async function applyHugoAccess(
  input: ApplyHugoAccessInput,
): Promise<ProvisionerReceipt> {
  const operationId = input.operationId ?? randomUUID();
  const email = normalizedEmail(input.email);
  const config = safeConfig(input.config ?? {});
  const expiresAt = input.accessExpiresAt ?? null;
  if (!validOperationId(operationId)) {
    return failureReceipt({
      operationId,
      role: input.role,
      config: config ?? {},
      status: input.status,
      expiresAt,
      code: "INVALID_OPERATION_ID",
      message: "Operation id must be a UUID.",
    });
  }
  if (!email || !email.includes("@")) {
    return failureReceipt({
      operationId,
      role: input.role,
      config: config ?? {},
      status: input.status,
      expiresAt,
      code: "INVALID_EMAIL",
      message: "A valid email is required.",
    });
  }
  if (!email.endsWith("@bmhgroupkc.com")) {
    return failureReceipt({
      operationId,
      role: input.role,
      config: config ?? {},
      status: input.status,
      expiresAt,
      code: "INVALID_DOMAIN",
      message: "Sandra access is limited to the BMH Group email domain.",
    });
  }
  if (!SANDRA_HUGO_ROLES.includes(input.role)) {
    return failureReceipt({
      operationId,
      config: config ?? {},
      status: input.status,
      expiresAt,
      code: "INVALID_ROLE",
      message: "Sandra role must be owner or member.",
    });
  }
  if (!config) {
    return failureReceipt({
      operationId,
      role: input.role,
      status: input.status,
      expiresAt,
      code: "INVALID_CONFIG",
      message: "Sandra access configuration cannot contain credentials.",
    });
  }

  let user: AuthUser | null = null;
  if (input.status === "active") {
    try {
      user = await ensureLocalIdentity(email);
    } catch {
      return failureReceipt({
        operationId,
        role: input.role,
        config,
        status: input.status,
        expiresAt,
        code: "IDENTITY_PROVISION_FAILED",
        message: "Sandra identity could not be provisioned.",
      });
    }
  }

  return callRpc(
    "hugo_apply_access",
    {
      p_operation_id: operationId,
      p_email: email,
      p_role: input.role,
      p_config: config,
      p_status: input.status,
      p_access_expires_at: expiresAt,
    },
    { operationId, role: input.role, config, status: input.status, expiresAt, appUserId: user?.id ?? null, code: "PROVISIONER_RPC_FAILED", message: "Sandra could not apply the requested access change." },
  );
}

export async function inspectHugoAccess(email: string): Promise<ProvisionerReceipt> {
  const normalized = normalizedEmail(email);
  return callRpc(
    "hugo_inspect_access",
    { p_email: normalized },
    { operationId: randomUUID(), status: "active", code: "PROVISIONER_RPC_FAILED", message: "Sandra could not inspect access." },
  );
}

export async function suspendHugoAccess(input: {
  email: string;
  operationId?: string;
  role?: SandraHugoRole;
  config?: HugoConfig;
  accessExpiresAt?: string | null;
}): Promise<ProvisionerReceipt> {
  return applyLifecycleStatus({ ...input, status: "suspended" });
}

export async function reactivateHugoAccess(input: {
  email: string;
  operationId?: string;
  role?: SandraHugoRole;
  config?: HugoConfig;
  accessExpiresAt?: string | null;
}): Promise<ProvisionerReceipt> {
  return applyLifecycleStatus({ ...input, status: "active" });
}

export async function revokeHugoAccess(input: {
  email: string;
  operationId?: string;
  role?: SandraHugoRole;
  config?: HugoConfig;
  accessExpiresAt?: string | null;
}): Promise<ProvisionerReceipt> {
  return applyLifecycleStatus({ ...input, status: "revoked" });
}

async function applyLifecycleStatus(input: {
  email: string;
  operationId?: string;
  role?: SandraHugoRole;
  config?: HugoConfig;
  status: SandraHugoStatus;
  accessExpiresAt?: string | null;
}): Promise<ProvisionerReceipt> {
  let role = input.role;
  let config = input.config;
  let expiresAt = input.accessExpiresAt ?? null;
  if (!role || !config) {
    const current = await inspectHugoAccess(input.email);
    if (current.observed.status !== "missing") {
      role = role ?? (current.observed.role as SandraHugoRole);
      config = config ?? current.observed.config;
      expiresAt = input.accessExpiresAt === undefined ? current.observed.access_expires_at : expiresAt;
    }
  }
  if (!role || !SANDRA_HUGO_ROLES.includes(role)) {
    return failureReceipt({ operationId: input.operationId ?? randomUUID(), status: input.status, code: "ACCESS_NOT_FOUND", message: "Sandra access was not found." });
  }
  return applyHugoAccess({ operationId: input.operationId, email: input.email, role, config: config ?? {}, status: input.status, accessExpiresAt: expiresAt });
}

export async function prepareHugoPristineDelete(input: {
  operationId?: string;
  email: string;
}): Promise<ProvisionerReceipt> {
  const operationId = input.operationId ?? randomUUID();
  const email = normalizedEmail(input.email);
  if (!validOperationId(operationId)) {
    return failureReceipt({ operationId, status: "revoked", code: "INVALID_OPERATION_ID", message: "Operation id must be a UUID." });
  }
  return callRpc(
    "hugo_prepare_pristine_delete",
    { p_operation_id: operationId, p_email: email },
    { operationId, status: "revoked", code: "PROVISIONER_RPC_FAILED", message: "Sandra could not prepare identity deletion." },
  );
}

export async function deleteHugoIdentity(input: {
  operationId?: string;
  email: string;
}): Promise<ProvisionerReceipt> {
  const operationId = input.operationId ?? randomUUID();
  const email = normalizedEmail(input.email);
  if (!validOperationId(operationId)) {
    return failureReceipt({ operationId, status: "revoked", code: "INVALID_OPERATION_ID", message: "Operation id must be a UUID." });
  }
  let existing: AuthUser | null = null;
  try {
    existing = await findExactUser(createAdminClient() as unknown as AuthAdmin, email);
  } catch {
    return failureReceipt({ operationId, status: "revoked", code: "IDENTITY_LOOKUP_FAILED", message: "Sandra identity could not be inspected for deletion." });
  }
  const receipt = await callRpc(
    "hugo_delete_identity",
    { p_operation_id: operationId, p_email: email },
    { operationId, status: "revoked", appUserId: existing?.id ?? null, code: "PROVISIONER_RPC_FAILED", message: "Sandra could not delete the identity." },
  );
  if (!receipt.ok || !existing) return receipt;
  try {
    const { error } = await (createAdminClient() as unknown as AuthAdmin).auth.admin.deleteUser(existing.id);
    if (!error) return receipt;
  } catch {
    // Keep this boundary secret-free and retryable. The SQL receipt remains
    // idempotent; the next delete call retries the Auth identity removal.
  }
  return {
    ...receipt,
    ok: false,
    error_code: "IDENTITY_DELETE_FAILED",
    error_message: "Sandra access was prepared, but the local identity could not be removed.",
  };
}

export const hugoAccessProvisioner = {
  grant: applyHugoAccess,
  suspend: suspendHugoAccess,
  reactivate: reactivateHugoAccess,
  revoke: revokeHugoAccess,
  inspect: inspectHugoAccess,
  preparePristineDelete: prepareHugoPristineDelete,
  deleteIdentity: deleteHugoIdentity,
};
