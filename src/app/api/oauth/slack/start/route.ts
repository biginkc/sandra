import { NextResponse } from "next/server";

import { ConfigurationError } from "@/lib/errors/classes";
import { reportError } from "@/lib/errors/report";
import { buildSlackAuthUrl } from "@/lib/integrations/slack/oauth";
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
    const signingSecret = process.env.SLACK_SIGNING_SECRET;
    const stateSecret = process.env.OAUTH_STATE_SIGNING_SECRET;
    const appUrl = process.env.APP_URL ?? new URL(request.url).origin;
    if (!clientId || !signingSecret || !stateSecret) {
      throw new ConfigurationError(
        "Slack OAuth start: missing SLACK_CLIENT_ID, SLACK_SIGNING_SECRET, or OAUTH_STATE_SIGNING_SECRET",
      );
    }

    const signedState = signOAuthState({
      userId: user.id,
      secret: stateSecret,
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
