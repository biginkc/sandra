export type SlackPreviewStateClaims = {
  userId: string;
  orgId: string;
  nonce: string;
  purpose: "slack_installation";
  returnPath?: string;
  issuedAt: number;
};

export function decodeSlackPreviewState(state: string): SlackPreviewStateClaims | null {
  const parts = state.split(".");
  if (parts.length !== 3 || parts[0] !== "v2") return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Partial<SlackPreviewStateClaims>;
    if (typeof claims.userId !== "string" || typeof claims.orgId !== "string" || typeof claims.nonce !== "string" || claims.purpose !== "slack_installation" || typeof claims.issuedAt !== "number") return null;
    if (claims.returnPath !== undefined && typeof claims.returnPath !== "string") return null;
    return claims as SlackPreviewStateClaims;
  } catch {
    return null;
  }
}
