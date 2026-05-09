import { NextResponse } from "next/server";

import { ConfigurationError } from "@/lib/errors/classes";
import { reportError } from "@/lib/errors/report";
import {
  buildGoogleAuthUrl,
  buildGoogleOauthClient,
} from "@/lib/integrations/google/oauth";
import { signOAuthState } from "@/lib/integrations/slack/state";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.redirect(new URL("/login", request.url));

    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    const stateSecret = process.env.OAUTH_STATE_SIGNING_SECRET;
    const appUrl = process.env.APP_URL ?? new URL(request.url).origin;
    if (!clientId || !clientSecret || !stateSecret) {
      throw new ConfigurationError(
        "Google OAuth start: missing credentials or state secret",
      );
    }

    const redirectUri =
      process.env.GOOGLE_OAUTH_REDIRECT_URI ??
      `${appUrl}/api/oauth/google/callback`;
    const client = buildGoogleOauthClient({
      clientId,
      clientSecret,
      redirectUri,
    });
    const signedState = signOAuthState({
      userId: user.id,
      secret: stateSecret,
    });

    return NextResponse.redirect(buildGoogleAuthUrl({ client, signedState }));
  } catch (error) {
    reportError(error, { tags: { surface: "oauth_google_start" } });
    return NextResponse.redirect(
      new URL("/settings/integrations?error=start", request.url),
    );
  }
}
