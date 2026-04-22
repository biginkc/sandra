import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

import { SetPasswordForm } from "./form";

/**
 * First-run "set your password" page reached after accepting an
 * invite. The session was already established by `/auth/callback`,
 * so we can show the current email read-only and ask for a password
 * they'll use on every subsequent sign-in.
 *
 * Also reachable post-login if someone wants to change their password,
 * though a proper profile page is a future add-on.
 */
export default async function SetPasswordPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login?error=invite_failed");
  }

  return (
    <div className="flex min-h-screen flex-1 items-center justify-center p-4">
      <div className="border-border w-full max-w-sm rounded-xl border p-6">
        <h1 className="text-lg font-semibold">Set your password</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Welcome to Sandra CRM. Pick a password for{" "}
          <span className="font-mono">{user.email}</span> so you can
          sign in next time.
        </p>
        <div className="mt-4">
          <SetPasswordForm email={user.email ?? ""} />
        </div>
      </div>
    </div>
  );
}
