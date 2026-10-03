import { NextResponse } from "next/server";

import { ConfigurationError } from "@/lib/errors/classes";
import { reportError } from "@/lib/errors/report";
import { buildSlackAuthUrl } from "@/lib/integrations/slack/oauth";
import { createSlackOAuthNonce, persistSlackOAuthNonce } from "@/lib/integrations/slack/installation";
import { signOAuthState } from "@/lib/integrations/slack/state";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.redirect(new URL("/login", request.url));

    const clientId = process.env.SLACK_CLIENT_ID;
    const stateSecret = process.env.OAUTH_STATE_SIGNING_SECRET;
    const appUrl = process.env.APP_URL ?? new URL(request.url).origin;
    if (!clientId || !stateSecret) {
      throw new ConfigurationError(
        "Slack OAuth start: missing SLACK_CLIENT_ID or OAUTH_STATE_SIGNING_SECRET",
      );
    }

    // Keep the existing notification reconnect path independent of the
    // preview migration. Preview authority is an explicit setup action after
    // the foundation schema is deployed and its separate gate is enabled.
    const query = new URL(request.url).searchParams;
    const previewRequested = query.get("preview") === "1" && process.env.SLACK_PREVIEW_OAUTH_ENABLED === "1";
    if (!previewRequested) {
      const signedState = signOAuthState({ userId: user.id, secret: stateSecret });
      return NextResponse.redirect(buildSlackAuthUrl({ clientId, redirectUri: `${appUrl}/api/oauth/slack/callback`, signedState }));
    }

    const requestedOrg = query.get("org_id") ?? query.get("orgId") ?? query.get("org");
    const requestedReturnPath = query.get("return_to");
    const returnPath = requestedReturnPath && isSafeRelativePath(requestedReturnPath) ? requestedReturnPath : null;
    const memberships = await readActiveMemberships(supabase, user.id);
    const orgId = requestedOrg ?? (memberships.length === 1 ? memberships[0] : null);
    if (!orgId || !memberships.includes(orgId)) throw new ConfigurationError("Slack OAuth start requires one authorized organization");

    const nonce = createSlackOAuthNonce();
    await persistSlackOAuthNonce({ nonceHash: nonce.nonceHash, userId: user.id, orgId, returnPath, expiresAt: nonce.expiresAt });

    const signedState = signOAuthState({
      userId: user.id,
      secret: stateSecret,
      orgId,
      nonce: nonce.nonce,
      returnPath: returnPath ?? undefined,
    });
    const url = buildSlackAuthUrl({
      clientId,
      redirectUri: `${appUrl}/api/oauth/slack/callback`,
      signedState,
    });

    return NextResponse.redirect(url);
  } catch (error) {
    reportError(error, { tags: { surface: "oauth_slack_start" } });
    return NextResponse.redirect(
      new URL("/settings/integrations?error=start", request.url),
    );
  }
}

function isSafeRelativePath(value: string): boolean {
  return value.startsWith("/") && !value.startsWith("//") && !value.includes("\\") && !/^https?:/i.test(value);
}

async function readActiveMemberships(supabase: Awaited<ReturnType<typeof createClient>>, userId: string): Promise<string[]> {
  const reader = supabase as unknown as { from(table: "memberships"): { select(columns: string): { eq(column: string, value: string): Promise<{ data: Array<Record<string, unknown>> | null; error: { message: string } | null }> } } };
  const result = await reader.from("memberships").select("org_id, user_id, access_status, access_expires_at, deletion_prepared_at").eq("user_id", userId);
  if (!result.error) {
    return (result.data ?? []).flatMap((row) => {
      if (typeof row.org_id !== "string") return [];
      if (row.access_status !== undefined && row.access_status !== null && row.access_status !== "active") return [];
      if (row.deletion_prepared_at) return [];
      if (typeof row.access_expires_at === "string" && Date.parse(row.access_expires_at) <= Date.now()) return [];
      return [row.org_id];
    });
  }
  const fallback = await reader.from("memberships").select("org_id, user_id").eq("user_id", userId);
  if (fallback.error) throw new Error("Membership access could not be verified");
  return (fallback.data ?? []).flatMap((row) => (typeof row.org_id === "string" ? [row.org_id] : []));
}
