"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { startHugoSignIn } from "@/lib/auth/start-hugo";

function firstForwarded(value: string | null): string | null {
  const first = value?.split(",")[0]?.trim();
  return first && first.length > 0 ? first : null;
}

/**
 * Start Sandra's only end-user authentication flow.
 *
 * The public feature flag remains a server-enforced rollout gate: deploying
 * this code before the provider is configured cannot accidentally start an
 * incomplete OIDC flow. Password and recovery actions deliberately do not
 * exist in this module.
 */
export async function signInWithHugo(
  _prevState: void,
  formData: FormData,
): Promise<void> {
  const h = await headers();
  const proto = firstForwarded(h.get("x-forwarded-proto")) ?? "https";
  const host = firstForwarded(h.get("x-forwarded-host")) ?? h.get("host");
  const configuredOrigin = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  const origin = host
    ? `${proto}://${host}`
    : configuredOrigin?.replace(/\/$/, "") || "https://sandra.bmhgroupkc.com";
  const result = await startHugoSignIn(origin, formData.get("next"));

  if (!result.ok) {
    if (result.reason === "disabled") {
      redirect("/login?error=sso_disabled");
    }
    redirect(
      result.next
        ? `/login?error=sso&next=${encodeURIComponent(result.next)}`
        : "/login?error=sso",
    );
  }
  redirect(result.authUrl);
}
