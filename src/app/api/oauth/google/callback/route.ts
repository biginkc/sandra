import { NextResponse } from "next/server";

import { reportError } from "@/lib/errors/report";
import {
  buildGoogleOauthClient,
  exchangeGoogleCode,
} from "@/lib/integrations/google/oauth";
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

    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    const appUrl = process.env.APP_URL ?? url.origin;
    if (!clientId || !clientSecret) {
      reportError(new Error("Google OAuth missing client credentials"), {
        tags: { surface: "oauth_google_callback" },
      });
      return NextResponse.redirect(settingsUrl("error=config"));
    }

    const redirectUri =
      process.env.GOOGLE_OAUTH_REDIRECT_URI ??
      `${appUrl}/api/oauth/google/callback`;
    const client = buildGoogleOauthClient({
      clientId,
      clientSecret,
      redirectUri,
    });
    const tokens = await exchangeGoogleCode({ client, code, clientId });

    await upsertOAuthToken({
      userId: user.id,
      provider: "google",
      tokenType: "user",
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
      scopes: tokens.scopes,
      externalAccountId: tokens.email,
    });

    return NextResponse.redirect(settingsUrl("connected=google"));
  } catch (error) {
    reportError(error, { tags: { surface: "oauth_google_callback" } });
    return NextResponse.redirect(settingsUrl("error=callback"));
  }
}
