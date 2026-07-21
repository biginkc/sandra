"use server";

import { ALLOWED_DOMAIN, isAdminEmail } from "@/lib/auth/allowlist";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

type MembershipAdminClient = {
  from(table: "memberships"): {
    upsert(
      values: {
        user_id: string;
        org_id: string;
        role: "owner" | "member";
      },
      options: { onConflict: "user_id,org_id" },
    ): Promise<{ error: { message: string } | null }>;
  };
};

/**
 * Grant Sandra access without issuing a Sandra password or authentication
 * email. Repeated grants preserve the canonical auth UID and simply upsert
 * the requested organization membership. Hugo owns identity activation.
 */
export async function grantUserAccess(
  email: string,
  orgId = "00000000-0000-0000-0000-000000000bbb",
  role: "owner" | "member" = "member",
): Promise<Result<{ grantedEmail: string; userId: string; created: boolean }>> {
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

    let target = await findExactUser();
    let created = false;
    if (!target) {
      const { data, error } = await admin.auth.admin.createUser({
        email: trimmed,
        email_confirm: true,
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

    const { error: membershipError } = await (
      admin as unknown as MembershipAdminClient
    )
      .from("memberships")
      .upsert(
        { user_id: target.id, org_id: orgId, role },
        { onConflict: "user_id,org_id" },
      );
    if (membershipError) {
      if (created) {
        const { error: rollbackError } = await admin.auth.admin.deleteUser(
          target.id,
        );
        if (rollbackError) {
          reportError(new Error(rollbackError.message), {
            tags: { surface: "grant_user_access_rollback" },
            extra: { email: trimmed, userId: target.id },
          });
        }
      }
      return {
        ok: false,
        error: {
          code: "GRANT_MEMBERSHIP_FAILED",
          message: membershipError.message,
        },
      };
    }

    return ok({ grantedEmail: trimmed, userId: target.id, created });
  } catch (e) {
    reportError(e, {
      tags: { surface: "grant_user_access" },
      extra: { email: trimmed },
    });
    return errFromUnknown(e, "GRANT_FAILED");
  }
}

/**
 * Kick a user out of Sandra. Admin-only. Revokes sessions + deletes
 * the auth record. Contacts / property ownership rows stay intact —
 * we don't cascade those because they represent real customer data
 * that survives a team member leaving.
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
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) {
      return {
        ok: false,
        error: { code: "REMOVE_FAILED", message: error.message },
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
