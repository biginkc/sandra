import { isAdminEmail } from "@/lib/auth/allowlist";
import { createClient } from "@/lib/supabase/server";

export async function getSequenceAdminStatus(): Promise<boolean> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return isAdminEmail(user?.email);
}

export async function requireSequenceAdmin(): Promise<
  | { ok: true }
  | { ok: false; error: { code: string; message: string } }
> {
  const isAdmin = await getSequenceAdminStatus();
  if (isAdmin) return { ok: true };

  return {
    ok: false,
    error: {
      code: "FORBIDDEN",
      message: "Only admins can create or edit sequences.",
    },
  };
}
