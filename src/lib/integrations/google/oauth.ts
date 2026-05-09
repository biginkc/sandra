import type { OAuth2Client } from "google-auth-library";
import { google } from "googleapis";

import { ProviderError } from "@/lib/errors/classes";

export const GOOGLE_CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/userinfo.email",
] as const;

export interface GoogleTokenExchangeResult {
  accessToken: string;
  refreshToken: string | null;
  accessTokenExpiresAt: string | null;
  scopes: string[];
  email: string | null;
}

interface GoogleOAuthTokens {
  access_token?: string | null;
  refresh_token?: string | null;
  expiry_date?: number | null;
  scope?: string;
  id_token?: string | null;
}

export function buildGoogleOauthClient(opts: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): OAuth2Client {
  return new google.auth.OAuth2(
    opts.clientId,
    opts.clientSecret,
    opts.redirectUri,
  );
}

export function buildGoogleAuthUrl(opts: {
  client: OAuth2Client;
  signedState: string;
}): string {
  return opts.client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [...GOOGLE_CALENDAR_SCOPES],
    state: opts.signedState,
    include_granted_scopes: true,
  });
}

export async function exchangeGoogleCode(opts: {
  client: OAuth2Client;
  code: string;
  clientId: string;
}): Promise<GoogleTokenExchangeResult> {
  let tokens: GoogleOAuthTokens;
  try {
    const response = await opts.client.getToken(opts.code);
    tokens = response.tokens;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ProviderError(`google getToken failed: ${message}`, "google");
  }

  if (!tokens?.access_token) {
    throw new ProviderError("google getToken returned no access_token", "google");
  }

  opts.client.setCredentials(tokens);

  let email: string | null = null;
  if (tokens.id_token) {
    try {
      const ticket = await opts.client.verifyIdToken({
        idToken: tokens.id_token,
        audience: opts.clientId,
      });
      email = ticket.getPayload()?.email ?? null;
    } catch {
      email = null;
    }
  }

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? null,
    accessTokenExpiresAt: tokens.expiry_date
      ? new Date(tokens.expiry_date).toISOString()
      : null,
    scopes: tokens.scope ? tokens.scope.split(" ") : [],
    email,
  };
}
