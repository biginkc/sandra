import { NextResponse } from "next/server";

import { reportError } from "@/lib/errors/report";
import { exchangeSlackCode } from "@/lib/integrations/slack/oauth";
import { verifyOAuthState } from "@/lib/integrations/slack/state";
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

    return NextResponse.redirect(settingsUrl("connected=slack"));
  } catch (error) {
    reportError(error, { tags: { surface: "oauth_slack_callback" } });
    return NextResponse.redirect(settingsUrl("error=callback"));
  }
}
