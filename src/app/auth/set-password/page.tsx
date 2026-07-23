import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

import { SetPasswordForm } from "./form";

/** Password setup is available only during the flag-off rollback path. */
export default async function SetPasswordPage() {
  if (process.env.NEXT_PUBLIC_HUGO_SSO === "1") {
    redirect("/login?error=password_disabled");
  }
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?error=invite_failed");

  return (
    <div className="flex min-h-screen flex-1 items-center justify-center p-4">
      <div className="border-border w-full max-w-sm rounded-xl border p-6">
        <h1 className="text-lg font-semibold">Set your password</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Pick a rollback password for <span className="font-mono">{user.email}</span>.
        </p>
        <div className="mt-4">
          <SetPasswordForm email={user.email ?? ""} />
        </div>
      </div>
    </div>
  );
}
