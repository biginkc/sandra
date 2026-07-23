"use server";

import { randomUUID } from "node:crypto";

import { ALLOWED_DOMAIN, isAdminEmail } from "@/lib/auth/allowlist";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { SANDRA_ORG_ID } from "@/lib/auth/sandra-org";

type MembershipRole = "owner" | "member";
type MembershipRow = { role: string };
type MembershipAdminClient = {
  from(table: "memberships"): {
    select(columns: "role"): {
      eq(column: "user_id", value: string): {
        eq(column: "org_id", value: string): {
          maybeSingle(): Promise<{
            data: MembershipRow | null;
            error: { message: string } | null;
          }>;
        };
      };
    };
    upsert(
      values: {
        user_id: string;
        org_id: string;
        role: MembershipRole;
      },
      options: {
        onConflict: "user_id,org_id";
        ignoreDuplicates: true;
      },
    ): Promise<{ error: { message: string } | null }>;
  };
};

type MembershipRemovalAdminClient = {
  from(table: "memberships"): {
    delete(): {
      eq(column: "user_id", value: string): {
        eq(
          column: "org_id",
          value: string,
        ): Promise<{ error: { message: string } | null }>;
      };
    };
    select(columns: "user_id"): {
      eq(column: "user_id", value: string): {
        eq(column: "org_id", value: string): {
          limit(count: 1): Promise<{
            data: Array<{ user_id: string }> | null;
            error: { message: string } | null;
          }>;
        };
      };
    };
  };
};

const PROVISIONING_STATE = "sandra_provisioning_state";
const PROVISIONING_ATTEMPT = "sandra_provisioning_attempt";
const PROVISIONING_STARTED_AT = "sandra_provisioning_started_at";
const PROVISIONING_LEASE_MS = 5 * 60 * 1000;

function pendingAttempt(user: { app_metadata?: Record<string, unknown> }) {
  if (user.app_metadata?.[PROVISIONING_STATE] !== "pending") return null;
  const marker = user.app_metadata[PROVISIONING_ATTEMPT];
  return typeof marker === "string" && marker ? marker : null;
}

function pendingLeaseIsActive(
  user: { app_metadata?: Record<string, unknown> },
  now = Date.now(),
) {
  if (!pendingAttempt(user)) return false;
  const startedAt = user.app_metadata?.[PROVISIONING_STARTED_AT];
  if (typeof startedAt !== "string") return false;
  const startedAtMs = Date.parse(startedAt);
  return Number.isFinite(startedAtMs) && now - startedAtMs < PROVISIONING_LEASE_MS;
}

/**
 * Grant Sandra access without issuing a Sandra password or authentication
 * email. Repeated grants preserve the canonical auth UID and any existing
 * organization role. Hugo owns identity activation.
 */
export async function grantUserAccess(
  email: string,
  role: MembershipRole = "member",
): Promise<
  Result<{
    grantedEmail: string;
    userId: string;
    created: boolean;
    warning?: string;
  }>
> {
  const trimmed = email.trim().toLowerCase();
  if (!trimmed.endsWith(`@${ALLOWED_DOMAIN}`)) {
    return {
      ok: false,
      error: {
        code: "INVALID_DOMAIN",
        message: `Email must end in @${ALLOWED_DOMAIN}.`,
      },
    };
  }
  if (role !== "owner" && role !== "member") {
    return {
      ok: false,
      error: { code: "INVALID_ROLE", message: "Role must be owner or member." },
    };
  }
  const orgId = SANDRA_ORG_ID;

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user || !isAdminEmail(user.email)) {
      return {
        ok: false,
        error: {
          code: "NOT_ADMIN",
          message: "Only admins can grant teammate access.",
        },
      };
    }

    const admin = createAdminClient();
    const membershipAdmin = admin as unknown as MembershipAdminClient;
    const attempt = randomUUID();
    const leaseStartedAt = new Date().toISOString();
    const findExactUser = async () => {
      for (let page = 1; page <= 100; page += 1) {
        const { data, error } = await admin.auth.admin.listUsers({
          page,
          perPage: 200,
        });
        if (error) throw error;
        const exact = data.users.find(
          (candidate) => candidate.email?.toLowerCase() === trimmed,
        );
        if (exact || data.users.length < 200) return exact ?? null;
      }
      throw new Error("User lookup exceeded the supported page limit.");
    };
    const findMembership = async (userId: string) => {
      const { data, error } = await membershipAdmin
        .from("memberships")
        .select("role")
        .eq("user_id", userId)
        .eq("org_id", orgId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data;
    };

    let target = await findExactUser();
    let created = false;
    if (!target) {
      if (process.env.NEXT_PUBLIC_HUGO_SSO !== "1") {
        return {
          ok: false,
          error: {
            code: "HUGO_REQUIRED",
            message:
              "Hugo must be active before granting a new teammate access.",
          },
        };
      }
      const { data, error } = await admin.auth.admin.createUser({
        email: trimmed,
        email_confirm: true,
        app_metadata: {
          [PROVISIONING_STATE]: "pending",
          [PROVISIONING_ATTEMPT]: attempt,
          [PROVISIONING_STARTED_AT]: leaseStartedAt,
        },
      });
      if (error || !data.user) {
        // A concurrent grant may have created the same exact-email account
        // after our initial lookup. Re-read once before returning failure.
        target = await findExactUser();
        if (!target) {
          return {
            ok: false,
            error: {
              code: "GRANT_FAILED",
              message: error?.message ?? "User creation returned no user.",
            },
          };
        }
      } else {
        target = data.user;
        created = true;
      }
    }

    let existingMembership = await findMembership(target.id);
    if (
      !existingMembership &&
      process.env.NEXT_PUBLIC_HUGO_SSO !== "1"
    ) {
      return {
        ok: false,
        error: {
          code: "HUGO_REQUIRED",
          message: "Hugo must be active before granting teammate access.",
        },
      };
    }
    const hadMembershipBeforeGrant = Boolean(existingMembership);
    const targetPendingAttempt = pendingAttempt(target);
    if (
      !existingMembership &&
      targetPendingAttempt &&
      targetPendingAttempt !== attempt
    ) {
      if (pendingLeaseIsActive(target)) {
        return {
          ok: false,
          error: {
            code: "GRANT_IN_PROGRESS",
            message:
              "Access provisioning is already in progress. Try again shortly.",
          },
        };
      }

      // A failed SDK call or interrupted request can leave a new Auth user in
      // the fail-closed pending state. Take over only after its lease expires,
      // then re-read the marker before doing any membership work. We never
      // delete a user when membership status is unknown.
      const { data: claimed, error: claimError } =
        await admin.auth.admin.updateUserById(target.id, {
          app_metadata: {
            ...target.app_metadata,
            [PROVISIONING_STATE]: "pending",
            [PROVISIONING_ATTEMPT]: attempt,
            [PROVISIONING_STARTED_AT]: leaseStartedAt,
          },
        });
      if (claimError || !claimed.user) {
        return {
          ok: false,
          error: {
            code: "GRANT_FAILED",
            message: claimError?.message ?? "Could not recover provisioning.",
          },
        };
      }
      const { data: ownership, error: ownershipError } =
        await admin.auth.admin.getUserById(target.id);
      if (
        ownershipError ||
        !ownership.user ||
        pendingAttempt(ownership.user) !== attempt
      ) {
        return {
          ok: false,
          error: {
            code: "GRANT_IN_PROGRESS",
            message:
              "Access provisioning was claimed by another request. Try again shortly.",
          },
        };
      }
      target = ownership.user;
    }

    if (!target.email_confirmed_at) {
      const { data, error } = await admin.auth.admin.updateUserById(target.id, {
        email_confirm: true,
      });
      if (error || !data.user) {
        return {
          ok: false,
          error: {
            code: "GRANT_FAILED",
            message: error?.message ?? "Could not activate the existing user.",
          },
        };
      }
      target = data.user;
    }

    if (!existingMembership) {
      const { error: membershipError } = await membershipAdmin
        .from("memberships")
        .upsert(
          { user_id: target.id, org_id: orgId, role },
          { onConflict: "user_id,org_id", ignoreDuplicates: true },
        );
      if (membershipError) {
        return {
          ok: false,
          error: {
            code: "GRANT_MEMBERSHIP_FAILED",
            message: membershipError.message,
          },
        };
      }
      existingMembership = await findMembership(target.id);
    }

    if (!existingMembership) {
      return {
        ok: false,
        error: {
          code: "GRANT_MEMBERSHIP_FAILED",
          message: "Membership could not be verified after provisioning.",
        },
      };
    }
    if (!hadMembershipBeforeGrant && existingMembership.role !== role) {
      return {
        ok: false,
        error: {
          code: "GRANT_ROLE_CONFLICT",
          message:
            "Another request granted this user a different role. Refresh and review their access.",
        },
      };
    }

    const { error: finalizeError } = await admin.auth.admin.updateUserById(
      target.id,
      {
        app_metadata: {
          ...target.app_metadata,
          [PROVISIONING_STATE]: "ready",
          [PROVISIONING_ATTEMPT]: null,
          [PROVISIONING_STARTED_AT]: null,
        },
      },
    );
    if (finalizeError) {
      // The verified membership is Sandra's authorization commit point. Do
      // not tell the operator access failed after it is already live; retain a
      // warning so the bookkeeping update can be retried safely.
      reportError(new Error(finalizeError.message), {
        tags: { surface: "grant_user_access_finalize" },
        extra: { userId: target.id },
      });
      return ok({
        grantedEmail: trimmed,
        userId: target.id,
        created,
        warning:
          "Sandra access is active, but provisioning status could not be finalized. Retry the grant to repair it.",
      });
    }

    return ok({ grantedEmail: trimmed, userId: target.id, created });
  } catch (e) {
    reportError(e, {
      tags: { surface: "grant_user_access" },
      extra: { email: trimmed },
    });
    const failure = errFromUnknown(e, "GRANT_FAILED");
    return { ...failure, error: { ...failure.error, code: "GRANT_FAILED" } };
  }
}

/**
 * Remove a user's Sandra membership without deleting their canonical Auth
 * identity. Membership is the authorization boundary, so existing sessions
 * are denied on their next protected request while CRM history and the UID
 * remain available for a later re-grant.
 */
export async function removeUser(
  userId: string,
): Promise<Result<null>> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user || !isAdminEmail(user.email)) {
      return {
        ok: false,
        error: { code: "NOT_ADMIN", message: "Only admins can remove users." },
      };
    }
    if (user.id === userId) {
      return {
        ok: false,
        error: {
          code: "CANT_REMOVE_SELF",
          message: "You can't remove your own account.",
        },
      };
    }

    const admin = createAdminClient();
    const membershipAdmin = admin as unknown as MembershipRemovalAdminClient;
    const { error: removeError } = await membershipAdmin
      .from("memberships")
      .delete()
      .eq("user_id", userId)
      .eq("org_id", SANDRA_ORG_ID);
    if (removeError) {
      return {
        ok: false,
        error: { code: "REMOVE_FAILED", message: removeError.message },
      };
    }

    const { data: remaining, error: verifyError } = await membershipAdmin
      .from("memberships")
      .select("user_id")
      .eq("user_id", userId)
      .eq("org_id", SANDRA_ORG_ID)
      .limit(1);
    if (verifyError || remaining?.length) {
      return {
        ok: false,
        error: {
          code: "REMOVE_FAILED",
          message:
            verifyError?.message ??
            "Sandra membership still exists after removal.",
        },
      };
    }
    return ok(null);
  } catch (e) {
    reportError(e, {
      tags: { surface: "remove_user" },
      extra: { userId },
    });
    return errFromUnknown(e, "REMOVE_FAILED");
  }
}
