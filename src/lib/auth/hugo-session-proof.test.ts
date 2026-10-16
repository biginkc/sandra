import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHugoSessionProof, hugoSessionCookieName, setHugoSessionProof, verifyHugoSessionProof } from "./hugo-session-proof";

const origin = "https://sandra.test";
const claims = { sub: "user-a", session_id: "session-a", iss: "https://auth.test/auth/v1",
  amr: [{ method: "oauth", timestamp: 1784616840 }] };
beforeEach(() => vi.stubEnv("HUGO_SESSION_PROOF_SECRET", "ab".repeat(32)));
afterEach(() => vi.unstubAllEnvs());

describe("session-bound Hugo proof", () => {
  it("survives refresh without accepting another session for the same account", async () => {
    const proof = await createHugoSessionProof(claims, claims.sub, origin);
    const refreshed = { ...claims, iat: 1784620440, exp: 1784624040,
      amr: [...claims.amr, { method: "token_refresh", timestamp: 1784620440 }] };
    expect(await verifyHugoSessionProof(proof, refreshed, claims.sub, origin)).toBe(true);
    expect(await verifyHugoSessionProof(proof, { ...claims, session_id: "session-b" }, claims.sub, origin)).toBe(false);
  });

  it.each([
    { sub: "user-b" }, { iss: "https://other.test/auth/v1" },
    { amr: [{ method: "password", timestamp: 1784616840 }] },
    { amr: [{ method: "oauth", timestamp: 1784617000 }] },
    { session_id: "" }, { amr: null },
  ])("rejects changed verified claims %j", async (change) => {
    const proof = await createHugoSessionProof(claims, claims.sub, origin);
    expect(await verifyHugoSessionProof(proof, { ...claims, ...change }, claims.sub, origin)).toBe(false);
  });

  it("rejects tampering, another user/origin, absent proof and key rotation", async () => {
    const proof = await createHugoSessionProof(claims, claims.sub, origin);
    expect(await verifyHugoSessionProof(`v1.${"0".repeat(64)}`, claims, claims.sub, origin)).toBe(false);
    expect(await verifyHugoSessionProof(proof, claims, "other-user", origin)).toBe(false);
    expect(await verifyHugoSessionProof(proof, claims, claims.sub, "https://preview.test")).toBe(false);
    expect(await verifyHugoSessionProof(undefined, claims, claims.sub, origin)).toBe(false);
    vi.stubEnv("HUGO_SESSION_PROOF_SECRET", "cd".repeat(32));
    expect(await verifyHugoSessionProof(proof, claims, claims.sub, origin)).toBe(false);
  });

  it("fails closed without a strong configured key", async () => {
    vi.stubEnv("HUGO_SESSION_PROOF_SECRET", "");
    await expect(createHugoSessionProof(claims, claims.sub, origin)).rejects.toThrow("key unavailable");
  });

  it("uses a host-only, secure, HttpOnly cookie and expires it on cleanup", () => {
    const request = new NextRequest(origin);
    const response = NextResponse.next();
    setHugoSessionProof(request, response, "proof");
    const cookie = response.cookies.get(hugoSessionCookieName(request));
    expect(cookie).toMatchObject({ name: "__Host-sandra-hugo-session", httpOnly: true, secure: true, sameSite: "lax", path: "/" });
    expect(cookie?.domain).toBeUndefined();
    setHugoSessionProof(request, response, "");
    expect(response.cookies.get(hugoSessionCookieName(request))?.maxAge).toBe(0);
  });
});
