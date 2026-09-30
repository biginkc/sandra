import { createClient as createSupabaseClient } from "@supabase/supabase-js";

import { isAdminEmail } from "@/lib/auth/allowlist";
import { runtimeSnapshot } from "@/lib/sequences/canary-runtime-proof";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
  // This path bypasses middleware redirects so CLI callers receive a real
  // 401/403. Resolve no provider or database configuration before this check.
  const authorization = request.headers.get("authorization");
  const token = authorization?.match(/^Bearer (\S+)$/i)?.[1];
  if (!token) return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return Response.json({ error: "Auth unavailable" }, { status: 503, headers });
  let auth;
  try {
    auth = createSupabaseClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  } catch {
    return Response.json({ error: "Auth unavailable" }, { status: 503, headers });
  }
  let user: { email?: string | null } | null = null;
  try {
    const result = await auth.auth.getUser(token);
    if (!result.error) user = result.data.user;
  } catch {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  }
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  if (!isAdminEmail(user.email)) return Response.json({ error: "Forbidden" }, { status: 403, headers });

  let body: unknown;
  try { body = await request.json(); } catch { body = null; }
  const nonce = typeof body === "object" && body !== null && "nonce" in body
    ? (body as { nonce: unknown }).nonce : null;
  if (typeof nonce !== "string" || !/^[0-9a-f]{32,128}$/i.test(nonce) || nonce.length % 2 !== 0) {
    return Response.json({ error: "A 128-bit or longer hex nonce is required" }, { status: 400, headers });
  }
  return Response.json(runtimeSnapshot(nonce), { headers });
}
