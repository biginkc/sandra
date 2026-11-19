import { AsyncLocalStorage } from "node:async_hooks";
import { createServer } from "node:http";
import { once } from "node:events";
import { chromium } from "@playwright/test";
import { NextRequest } from "next/server";
import { afterEach, expect, it, vi } from "vitest";

// Browser regression through the actual callback, server-cookie adapter and
// middleware. Only the external Supabase API is replaced by a deterministic
// provider fixture; this is not a claim of hosted OAuth acceptance.
const context = new AsyncLocalStorage<{ request: NextRequest; writes: Map<string, string> }>();
const sessions = new Map<string, { id: string; at: number; refreshed: boolean; revoked: boolean }>();
let identityAt = 1784616840;
let memberActive = true;
const uid = "browser-user";
const user = () => ({ id: uid, email: "browser@bmhgroupkc.com", identities: [{
  provider: "custom:hugo", last_sign_in_at: "2026-04-21T00:00:00Z",
  updated_at: new Date(identityAt * 1000).toISOString(),
}] });
const claims = (session: NonNullable<ReturnType<typeof sessions.get>>) => ({
  sub: uid, session_id: session.id, iss: "https://auth.test/auth/v1",
  iat: session.at + (session.refreshed ? 3600 : 0),
  amr: [{ method: "oauth", timestamp: session.at },
    ...(session.refreshed ? [{ method: "token_refresh", timestamp: session.at + 3600 }] : [])],
});

vi.mock("next/headers", () => ({ cookies: async () => ({
  getAll: () => context.getStore()!.request.cookies.getAll(),
  set: (name: string, value: string) => context.getStore()!.writes.set(name, value),
}) }));
vi.mock("@supabase/ssr", () => ({ createServerClient: (_url: string, _key: string, options: {
  cookies: { getAll: () => Array<{ name: string; value: string }>; setAll: (cookies: unknown[]) => void };
}) => {
  let current = sessions.get(options.cookies.getAll().find(c => c.name === "test-auth")?.value ?? "");
  const limit = async () => ({ data: memberActive ? [{ user_id: uid, access_status: "active" }] : [], error: null });
  const query = { select: () => query, eq: () => query, limit };
  return { from: () => query, auth: {
    getUser: async () => ({ data: { user: current && !current.revoked ? user() : null }, error: null }),
    getClaims: async () => ({ data: { claims: current ? claims(current) : null }, error: null }),
    exchangeCodeForSession: async (code: string) => {
      identityAt += 780; // distinct logins >60 seconds apart, reproducing the bug
      current = { id: code, at: identityAt, refreshed: false, revoked: false };
      sessions.set(code, current);
      options.cookies.setAll([{ name: "test-auth", value: code, options: { path: "/", httpOnly: true } }]);
      return { data: { session: { access_token: "fixture-token", user: user() } }, error: null };
    },
    signOut: async () => { if (current) current.revoked = true; return { error: null }; },
  } };
} }));

import { GET } from "../../src/app/auth/callback/route";
import { updateSession } from "../../src/lib/supabase/middleware";

const nonce = "a".repeat(43);
const flowState = Buffer.from(JSON.stringify([{ name: "sb-fixture-auth-token-code-verifier", value: "fixture" }])).toString("base64url");
afterEach(() => vi.unstubAllEnvs());

it("two independent browsers stay authenticated through another sign-in and refresh; revoked access still fails", async () => {
  vi.stubEnv("NEXT_PUBLIC_HUGO_SSO", "1");
  vi.stubEnv("HUGO_SESSION_PROOF_SECRET", "ab".repeat(32));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://fixture.supabase.co");
  vi.stubEnv("E2E_AUTH_BYPASS", "0");
  sessions.clear(); memberActive = true;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      if (url.pathname === "/login") { res.end("Sign in required"); return; }
      if (url.pathname === "/start") {
        const id = url.searchParams.get("session")!;
        res.setHeader("Set-Cookie", `sandra_hugo_flow_${nonce}=${flowState}; Path=/; HttpOnly; SameSite=Lax`);
        res.end(`<a href="/auth/callback?code=${id}&hugo_source=hugo&hugo_flow=${nonce}">Sign in with Hugo</a>`); return;
      }
      if (url.pathname === "/favicon.ico") { res.end(); return; }
      const request = new NextRequest(url, { headers: req.headers as Record<string, string> });
      const writes = new Map<string, string>();
      const response = await context.run({ request, writes }, () => url.pathname === "/auth/callback" ? GET(request) : updateSession(request));
      res.statusCode = response.status;
      for (const [name, value] of response.headers) if (name !== "set-cookie") res.setHeader(name, value);
      res.setHeader("Set-Cookie", [...response.headers.getSetCookie(), ...Array.from(writes, ([name, value]) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax`)]);
      res.end(response.headers.has("x-middleware-next") ? "Authenticated dashboard" : await response.text());
    } catch { res.statusCode = 500; res.end("Fixture failed"); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://localhost:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const a = await browser.newContext(); const b = await browser.newContext();
    const pageA = await a.newPage(); const pageB = await b.newPage();
    await pageA.goto(`${origin}/start?session=a`); await pageA.getByText("Sign in with Hugo").click();
    expect(await pageA.textContent("body")).toBe("Authenticated dashboard");
    await pageB.goto(`${origin}/start?session=b`); await pageB.getByText("Sign in with Hugo").click();
    expect(await pageB.textContent("body")).toBe("Authenticated dashboard");
    await pageA.goto(`${origin}/dashboard`);
    expect(await pageA.textContent("body")).toBe("Authenticated dashboard");
    sessions.get("a")!.refreshed = true;
    await pageA.reload(); expect(await pageA.textContent("body")).toBe("Authenticated dashboard");
    await pageB.reload(); expect(await pageB.textContent("body")).toBe("Authenticated dashboard");
    expect(sessions.get("a")!.revoked).toBe(false); expect(sessions.get("b")!.revoked).toBe(false);
    const proofA = (await a.cookies()).find(c => c.name === "sandra-hugo-session")!;
    const proofB = (await b.cookies()).find(c => c.name === "sandra-hugo-session")!;
    expect(proofA.value).not.toBe(proofB.value);
    expect(proofA.httpOnly).toBe(true);
    // An unrelated OAuth session cannot borrow A's trusted provider marker.
    sessions.set("other", { id: "other", at: identityAt, refreshed: false, revoked: false });
    const c = await browser.newContext();
    await c.addCookies([{ ...proofA }, { name: "test-auth", value: "other", url: origin }]);
    const pageC = await c.newPage(); await pageC.goto(`${origin}/dashboard`);
    expect(pageC.url()).toContain("/login?error=password_disabled");
    memberActive = false; await pageA.reload();
    expect(pageA.url()).toContain("/login?error=access");
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 30000);
