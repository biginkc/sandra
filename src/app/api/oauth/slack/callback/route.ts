import { NextResponse } from "next/server";

import { reportError } from "@/lib/errors/report";
import { exchangeSlackCode } from "@/lib/integrations/slack/oauth";
import { consumeSlackOAuthNonce, hashSlackOAuthNonce, upsertSlackInstallationAndAccountLink } from "@/lib/integrations/slack/installation";
import { verifyOAuthState } from "@/lib/integrations/slack/state";
import { decodeSlackPreviewState } from "@/lib/integrations/slack/state-claims";
import { upsertOAuthToken } from "@/lib/integrations/tokens/store";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const settingsUrl = (queryString: string) =>
    new URL(`/settings/integrations?${queryString}`, request.url);

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.redirect(new URL("/login", request.url));

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const stateSecret = process.env.OAUTH_STATE_SIGNING_SECRET;
    if (!code || !state || !stateSecret) {
      return NextResponse.redirect(settingsUrl("error=state"));
    }

    const stateOk = verifyOAuthState({
      state,
      secret: stateSecret,
      expectedUserId: user.id,
    });
    if (!stateOk) return NextResponse.redirect(settingsUrl("error=state"));
    const claims = decodeSlackPreviewState(state);
    if (state.startsWith("v2.")) {
      if (!claims?.orgId || !claims.nonce || !verifyOAuthState({ state, secret: stateSecret, expectedUserId: user.id, expectedOrgId: claims.orgId, expectedPurpose: "slack_installation", requireNonce: true })) {
        return NextResponse.redirect(settingsUrl("error=state"));
      }
    }

    // Legacy Slack states remain valid for notification reconnects while the
    // preview foundation is rolled out. They never acquire preview authority;
    // only the v2 state below can create an installation/account binding.
    const previewState = state.startsWith("v2.") && claims?.orgId && claims.nonce;
    if (state.startsWith("v2.") && !previewState) return NextResponse.redirect(settingsUrl("error=state"));
    if (previewState) {
      const consumed = await consumeSlackOAuthNonce({ nonceHash: hashSlackOAuthNonce(claims.nonce!), userId: user.id, orgId: claims.orgId! });
      if (!consumed) return NextResponse.redirect(settingsUrl("error=state"));
      if (!(await isActiveOrgMember(supabase, user.id, claims.orgId!))) return NextResponse.redirect(settingsUrl("error=state"));
    }

    const clientId = process.env.SLACK_CLIENT_ID;
    const clientSecret = process.env.SLACK_CLIENT_SECRET;
    const appUrl = process.env.APP_URL ?? url.origin;
    if (!clientId || !clientSecret) {
      reportError(new Error("Slack OAuth missing client credentials"), {
        tags: { surface: "oauth_slack_callback" },
      });
      return NextResponse.redirect(settingsUrl("error=config"));
    }

    const tokens = await exchangeSlackCode({
      clientId,
      clientSecret,
      code,
      redirectUri: `${appUrl}/api/oauth/slack/callback`,
    });
    if (!tokens.botToken || !tokens.botUserId || !tokens.appId || !tokens.teamId || (process.env.SLACK_APP_ID && process.env.SLACK_APP_ID !== tokens.appId)) {
      return NextResponse.redirect(settingsUrl("error=callback"));
    }

    await upsertOAuthToken({
      userId: user.id,
      provider: "slack",
      tokenType: "bot",
      accessToken: tokens.botToken,
      refreshToken: null,
      accessTokenExpiresAt: null,
      scopes: tokens.scopes,
      externalAccountId: tokens.userId,
    });

    if (tokens.userToken) {
      await upsertOAuthToken({
        userId: user.id,
        provider: "slack",
        tokenType: "user",
        accessToken: tokens.userToken,
        refreshToken: null,
        accessTokenExpiresAt: null,
        scopes: tokens.userScopes,
        externalAccountId: tokens.userId,
      });
    }

    if (previewState) {
      if (!tokens.userId) return NextResponse.redirect(settingsUrl("error=callback"));
      await upsertSlackInstallationAndAccountLink({
        orgId: claims.orgId!,
        teamId: tokens.teamId,
        appId: tokens.appId,
        teamName: tokens.teamName,
        botUserId: tokens.botUserId,
        botToken: tokens.botToken,
        scopes: tokens.scopes,
        installedBy: user.id,
        slackUserId: tokens.userId,
      });
    }

    const continuation = previewState && claims.returnPath && isSafeRelativePath(claims.returnPath) ? new URL(claims.returnPath, request.url) : settingsUrl("connected=slack");
    if (continuation.pathname === "/settings/integrations" && !continuation.searchParams.has("connected")) continuation.searchParams.set("connected", "slack");
    return NextResponse.redirect(continuation);
  } catch (error) {
    reportError(error, { tags: { surface: "oauth_slack_callback" } });
    return NextResponse.redirect(settingsUrl("error=callback"));
  }
}

async function isActiveOrgMember(supabase: Awaited<ReturnType<typeof createClient>>, userId: string, orgId: string): Promise<boolean> {
  const reader = supabase as unknown as { from(table: "memberships"): { select(columns: string): { eq(column: string, value: string): { eq(column: string, value: string): Promise<{ data: Array<Record<string, unknown>> | null; error: { message: string } | null }> } } } };
  const result = await reader.from("memberships").select("org_id, user_id, access_status, access_expires_at, deletion_prepared_at").eq("user_id", userId).eq("org_id", orgId);
  if (result.error) return false;
  const row = result.data?.[0];
  return !!row && row.user_id === userId && row.org_id === orgId && (row.access_status === undefined || row.access_status === null || row.access_status === "active") && !row.deletion_prepared_at && (typeof row.access_expires_at !== "string" || Date.parse(row.access_expires_at) > Date.now());
}

function isSafeRelativePath(value: string): boolean {
  return value.startsWith("/") && !value.startsWith("//") && !value.includes("\\") && !/^https?:/i.test(value);
}
