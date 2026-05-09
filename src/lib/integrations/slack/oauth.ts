import { WebClient } from "@slack/web-api";

import { ProviderError } from "@/lib/errors/classes";

const SLACK_AUTHORIZE = "https://slack.com/oauth/v2/authorize";

export const SLACK_BOT_SCOPES = [
  "chat:write",
  "im:write",
  "users:read",
  "users:read.email",
] as const;

export const SLACK_USER_SCOPES = [] as const;

export interface SlackTokenExchangeResult {
  botToken: string;
  botUserId: string;
  appId: string;
  teamId: string;
  teamName?: string;
  scopes: string[];
  userToken: string | null;
  userId: string | null;
  userScopes: string[];
}

export function buildSlackAuthUrl(opts: {
  clientId: string;
  redirectUri: string;
  signedState: string;
}): string {
  const url = new URL(SLACK_AUTHORIZE);
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("scope", SLACK_BOT_SCOPES.join(","));
  url.searchParams.set("user_scope", SLACK_USER_SCOPES.join(","));
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("state", opts.signedState);
  return url.toString();
}

export async function exchangeSlackCode(opts: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<SlackTokenExchangeResult> {
  const client = new WebClient();
  const response = await client.oauth.v2.access({
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    code: opts.code,
    redirect_uri: opts.redirectUri,
  });

  if (!response.ok) {
    throw new ProviderError(
      `oauth.v2.access failed: ${response.error ?? "unknown_error"}`,
      "slack",
    );
  }

  return {
    botToken: response.access_token ?? "",
    botUserId: response.bot_user_id ?? "",
    appId: response.app_id ?? "",
    teamId: response.team?.id ?? "",
    teamName: response.team?.name,
    scopes: response.scope ? response.scope.split(",") : [],
    userToken: response.authed_user?.access_token ?? null,
    userId: response.authed_user?.id ?? null,
    userScopes: response.authed_user?.scope
      ? response.authed_user.scope.split(",")
      : [],
  };
}
