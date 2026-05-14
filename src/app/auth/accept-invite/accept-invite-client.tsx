"use client";

import { createBrowserClient } from "@supabase/ssr";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { isEmailAllowed } from "@/lib/auth/allowlist";
import type { Database } from "@/lib/supabase/types";

function clearHashFromAddressBar() {
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${window.location.search}`,
  );
}

export function AcceptInviteClient() {
  const router = useRouter();
  const [message, setMessage] = useState("Accepting your Sandra invite...");

  useEffect(() => {
    let cancelled = false;

    async function acceptInvite() {
      const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
      const accessToken = params.get("access_token");
      const refreshToken = params.get("refresh_token");
      const errorDescription = params.get("error_description");

      clearHashFromAddressBar();

      if (errorDescription) {
        toast.error("Invite link failed", { description: errorDescription });
        router.replace("/login?error=invite_failed");
        return;
      }

      if (!accessToken || !refreshToken) {
        router.replace("/login?error=invite_failed");
        return;
      }

      const supabase = createBrowserClient<Database>(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
          auth: { detectSessionInUrl: false },
          isSingleton: false,
        },
      );

      const { data, error } = await supabase.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken,
      });

      if (cancelled) return;

      if (error || !data.session) {
        toast.error("Invite link failed", {
          description: error?.message ?? "No session was returned.",
        });
        router.replace("/login?error=invite_failed");
        return;
      }

      if (!isEmailAllowed(data.session.user.email)) {
        await supabase.auth.signOut();
        router.replace("/login?error=domain");
        return;
      }

      setMessage("Invite accepted. Redirecting...");
      router.replace("/auth/set-password");
    }

    void acceptInvite();

    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    <div className="flex min-h-screen flex-1 items-center justify-center p-4">
      <div className="border-border w-full max-w-sm rounded-xl border p-6">
        <h1 className="text-lg font-semibold">{message}</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Keep this tab open while Sandra verifies the one-time invite link.
        </p>
      </div>
    </div>
  );
}
