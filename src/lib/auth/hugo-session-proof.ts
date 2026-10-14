import "server-only";

import type { NextRequest, NextResponse } from "next/server";

// This is evidence of the provider used for one session, not an access grant.
// Supabase user/JWT verification and Sandra membership checks remain mandatory.
export function hugoSessionCookieName(request: NextRequest): string {
  return request.nextUrl.protocol === "https:"
    ? "__Host-sandra-hugo-session"
    : "sandra-hugo-session";
}

export function hugoSessionProofConfigured(): boolean {
  return /^[a-f0-9]{64}$/i.test(process.env.HUGO_SESSION_PROOF_SECRET ?? "");
}

type Claims = {
  sub?: unknown;
  iss?: unknown;
  session_id?: unknown;
  amr?: unknown;
};

function binding(claims: Claims, userId: string, origin: string): string | null {
  if (
    claims.sub !== userId || !userId ||
    typeof claims.iss !== "string" || !claims.iss ||
    typeof claims.session_id !== "string" || !claims.session_id ||
    !Array.isArray(claims.amr)
  ) return null;
  const oauthTimes = claims.amr.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== "object") return [];
    const { method, timestamp } = entry as { method?: unknown; timestamp?: unknown };
    return (method === "oauth" || method === "oauth_provider/authorization_code") &&
      typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0
      ? [timestamp] : [];
  });
  if (!oauthTimes.length) return null;
  // exp/iat change on refresh; session_id and the OAuth AMR do not.
  return JSON.stringify(["sandra-hugo-session-v1", origin, claims.iss,
    userId, claims.session_id, Math.max(...oauthTimes)]);
}

async function signingKey() {
  if (!hugoSessionProofConfigured()) throw new Error("Hugo session proof key unavailable");
  const secret = process.env.HUGO_SESSION_PROOF_SECRET!;
  const bytes = Uint8Array.from(secret.match(/../g)!, (pair) => parseInt(pair, 16));
  return crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" },
    false, ["sign", "verify"]);
}

/** Only call after the nonce-bound callback verifies the Hugo exchange. */
export async function createHugoSessionProof(
  claims: Claims, userId: string, origin: string,
): Promise<string> {
  const data = binding(claims, userId, origin);
  if (!data) throw new Error("Hugo session binding unavailable");
  const signature = await crypto.subtle.sign("HMAC", await signingKey(), new TextEncoder().encode(data));
  return `v1.${Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function verifyHugoSessionProof(
  proof: string | undefined, claims: Claims, userId: string, origin: string,
): Promise<boolean> {
  if (!proof || !/^v1\.[a-f0-9]{64}$/.test(proof)) return false;
  const data = binding(claims, userId, origin);
  if (!data) return false;
  const signature = Uint8Array.from(proof.slice(3).match(/../g)!, (pair) => parseInt(pair, 16));
  return crypto.subtle.verify("HMAC", await signingKey(), signature, new TextEncoder().encode(data));
}

export function setHugoSessionProof(request: NextRequest, response: NextResponse, value: string) {
  response.cookies.set(hugoSessionCookieName(request), value, {
    httpOnly: true, secure: request.nextUrl.protocol === "https:",
    sameSite: "lax", path: "/", maxAge: value ? 365 * 24 * 60 * 60 : 0,
  });
}
