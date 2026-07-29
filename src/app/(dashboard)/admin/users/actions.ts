"use server";

import { isAdminEmail } from "@/lib/auth/allowlist";
import { SANDRA_ORG_ID } from "@/lib/auth/sandra-org";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type MembershipRole = "owner" | "member";

type MembershipRoleRow = {
  user_id: string;
  role: string;
};

type MembershipRoleUpdateQuery = {
  eq(
    column: "user_id" | "org_id" | "access_status",
    value: string,
  ): MembershipRoleUpdateQuery;
  is(column: "deletion_prepared_at", value: null): MembershipRoleUpdateQuery;
  or(filters: string): MembershipRoleUpdateQuery;
  select(columns: "user_id,role"): {
    maybeSingle(): Promise<{
      data: MembershipRoleRow | null;
      error: { message: string } | null;
    }>;
  };
};

type MembershipRoleAdminClient = {
  from(table: "memberships"): {
    update(values: { role: MembershipRole }): MembershipRoleUpdateQuery;
  };
};

/**
 * Change Sandra's app-owned role for a person who already has Sandra access.
 *
 * This deliberately uses UPDATE, never UPSERT: Hugo owns account creation and
 * access grants, so a missing membership must remain missing.
 */
export async function updateMembershipRole(
  userId: string,
  role: MembershipRole,
): Promise<Result<{ userId: string; role: MembershipRole }>> {
  const targetUserId = userId.trim();
  if (!targetUserId) {
    return {
      ok: false,
      error: {
        code: "INVALID_USER",
        message: "Choose an existing Sandra team member.",
      },
    };
  }
  if (role !== "owner" && role !== "member") {
    return {
      ok: false,
      error: {
        code: "INVALID_ROLE",
        message: "Role must be owner or member.",
      },
    };
  }

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
          message: "Only admins can change Sandra roles.",
        },
      };
    }

    const membershipAdmin =
      createAdminClient() as unknown as MembershipRoleAdminClient;
    const { data, error } = await membershipAdmin
      .from("memberships")
      .update({ role })
      .eq("user_id", targetUserId)
      .eq("org_id", SANDRA_ORG_ID)
      .eq("access_status", "active")
      .is("deletion_prepared_at", null)
      .or(
        `access_expires_at.is.null,access_expires_at.gt.${new Date().toISOString()}`,
      )
      .select("user_id,role")
      .maybeSingle();

    if (error) {
      return {
        ok: false,
        error: {
          code: "ROLE_UPDATE_FAILED",
          message: error.message,
        },
      };
    }
    if (!data) {
      return {
        ok: false,
        error: {
          code: "MEMBERSHIP_NOT_FOUND",
          message:
            "This person does not have active Sandra access. Add or reactivate them in Hugo first.",
        },
      };
    }
    if (data.user_id !== targetUserId || data.role !== role) {
      return {
        ok: false,
        error: {
          code: "ROLE_UPDATE_FAILED",
          message: "Sandra could not verify the saved role.",
        },
      };
    }

    return ok({ userId: data.user_id, role });
  } catch (error) {
    reportError(error, {
      tags: { surface: "update_membership_role" },
      extra: { userId: targetUserId, role },
    });
    const failure = errFromUnknown(error, "ROLE_UPDATE_FAILED");
    return {
      ...failure,
      error: { ...failure.error, code: "ROLE_UPDATE_FAILED" },
    };
  }
}
