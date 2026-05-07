"use server";

import { ALLOWED_DOMAIN, isAdminEmail } from "@/lib/auth/allowlist";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

type MembershipAdminClient = {
  from(table: "memberships"): {
    insert(values: {
      user_id: string;
      org_id: string;
      role: "owner" | "member";
    }): Promise<{ error: { message: string } | null }>;
  };
};

/**
 * Invite a teammate. Admin-only. Uses Supabase's built-in invite flow:
 * Supabase sends a branded email with a one-time link → recipient
 * clicks → lands on /auth/callback → redirected to /auth/set-password
 * → picks a password → signed in.
 *
 * Strict about the email: must be `@bmhgroupkc.com` (the allowed
 * domain). Non-admins can't call this — they'd hit the same guard on
 * /admin/users and wouldn't see the form.
 */
export async function inviteUser(
  email: string,
  orgId = "00000000-0000-0000-0000-000000000bbb",
  role: "owner" | "member" = "member",
): Promise<Result<{ invitedEmail: string }>> {
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
          message: "Only admins can invite teammates.",
        },
      };
    }

    const admin = createAdminClient();
    const redirectTo =
      (process.env.NEXT_PUBLIC_SITE_URL ??
        "https://sandra-jarrad-5416s-projects.vercel.app") +
      "/auth/callback?type=invite";
    const { data, error } = await admin.auth.admin.inviteUserByEmail(
      trimmed,
      {
        redirectTo,
      },
    );
    if (error) {
      return {
        ok: false,
        error: { code: "INVITE_FAILED", message: error.message },
      };
    }
    if (!data.user?.id) {
      return {
        ok: false,
        error: { code: "INVITE_FAILED", message: "Invite did not return a user." },
      };
    }

    const { error: membershipError } = await (
      admin as unknown as MembershipAdminClient
    )
      .from("memberships")
      .insert({ user_id: data.user.id, org_id: orgId, role });
    if (membershipError) {
      await admin.auth.admin.deleteUser(data.user.id);
      return {
        ok: false,
        error: {
          code: "INVITE_MEMBERSHIP_FAILED",
          message: membershipError.message,
        },
      };
    }

    return ok({ invitedEmail: trimmed });
  } catch (e) {
    reportError(e, {
      tags: { surface: "invite_user" },
      extra: { email: trimmed },
    });
    return errFromUnknown(e, "INVITE_FAILED");
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
