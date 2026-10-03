import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_MAX_AGE_SEC = 600;

export type SlackOAuthStateClaims = {
  userId: string;
  orgId?: string;
  nonce?: string;
  purpose?: "slack_installation";
  returnPath?: string;
  issuedAt: number;
};

export function signOAuthState(opts: {
  userId: string;
  secret: string;
  orgId?: string;
  nonce?: string;
  purpose?: "slack_installation";
  returnPath?: string;
  now?: number;
}): string {
  const now = opts.now ?? Math.floor(Date.now() / 1000);

  // Keep the original compact format for Google OAuth. Slack installation
  // state uses a versioned, authenticated JSON payload so org and nonce are
  // cryptographically bound to the browser session.
  if (opts.orgId && opts.nonce) {
    const claims: SlackOAuthStateClaims = {
      userId: opts.userId,
      orgId: opts.orgId,
      nonce: opts.nonce,
      purpose: opts.purpose ?? "slack_installation",
      ...(opts.returnPath ? { returnPath: opts.returnPath } : {}),
      issuedAt: now,
    };
    const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
    const signed = `v2.${payload}`;
    const hmac = createHmac("sha256", opts.secret).update(signed).digest("hex");
    return `${signed}.${hmac}`;
  }

  const payload = `${opts.userId}.${now}`;
  const hmac = createHmac("sha256", opts.secret).update(payload).digest("hex");
  return `${payload}.${hmac}`;
}

export function verifyOAuthState(opts: {
  state: string;
  secret: string;
  expectedUserId: string;
  expectedOrgId?: string;
  expectedPurpose?: "slack_installation";
  requireNonce?: boolean;
  now?: number;
  maxAgeSec?: number;
}): boolean {
  const claims = parseOAuthState(opts.state);
  if (!claims || claims.userId !== opts.expectedUserId) return false;
  if (opts.expectedOrgId && claims.orgId !== opts.expectedOrgId) return false;
  if (opts.expectedPurpose && claims.purpose !== opts.expectedPurpose) return false;
  if (opts.requireNonce && (!claims.nonce || !claims.orgId || !claims.purpose)) return false;

  const timestamp = claims.issuedAt;
  if (!Number.isFinite(timestamp)) return false;

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const maxAgeSec = opts.maxAgeSec ?? DEFAULT_MAX_AGE_SEC;
  if (now - timestamp > maxAgeSec || timestamp > now + 60) return false;

  const signedPayload = opts.state.startsWith("v2.")
    ? opts.state.slice(0, opts.state.lastIndexOf("."))
    : `${claims.userId}.${timestamp}`;
  const expected = createHmac("sha256", opts.secret).update(signedPayload).digest("hex");
  const hmacHex = opts.state.slice(opts.state.lastIndexOf(".") + 1);
  const actualBuffer = Buffer.from(hmacHex, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  if (actualBuffer.length !== expectedBuffer.length || actualBuffer.length === 0) {
    return false;
  }

  return timingSafeEqual(actualBuffer, expectedBuffer);
}

export function parseOAuthState(state: string): SlackOAuthStateClaims | null {
  const parts = state.split(".");
  if (parts.length === 3 && parts[0] !== "v2") {
    const issuedAt = Number(parts[1]);
    if (!parts[0] || !Number.isFinite(issuedAt)) return null;
    return { userId: parts[0], issuedAt };
  }
  if (parts.length !== 3 || parts[0] !== "v2" || !parts[1]) return null;
  try {
    const parsed = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Partial<SlackOAuthStateClaims>;
    if (typeof parsed.userId !== "string" || typeof parsed.issuedAt !== "number") return null;
    if (parsed.orgId !== undefined && typeof parsed.orgId !== "string") return null;
    if (parsed.nonce !== undefined && typeof parsed.nonce !== "string") return null;
    if (parsed.purpose !== undefined && parsed.purpose !== "slack_installation") return null;
    if (parsed.returnPath !== undefined && typeof parsed.returnPath !== "string") return null;
    return parsed as SlackOAuthStateClaims;
  } catch {
    return null;
  }
}
