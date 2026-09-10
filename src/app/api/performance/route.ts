import { createClient } from "@/lib/supabase/server";
import { parseBrowserSample } from "@/lib/performance/browser-sample";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

/** Content-free RUM. Client measurements are untrusted performance observations,
 * never authorization or billing data. Reject before reading more than 4 KiB. */
export async function POST(request: Request) {
  if (process.env.SANDRA_PERFORMANCE_TELEMETRY !== "1") return new Response(null, { status: 204, headers });
  if (request.headers.get("origin") !== new URL(request.url).origin) return new Response(null, { status: 403, headers });
  const reader = request.body?.getReader();
  if (!reader) return new Response(null, { status: 400, headers });
  let size = 0;
  let body = "";
  const decoder = new TextDecoder();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 4096) {
        await reader.cancel();
        return new Response(null, { status: 413, headers });
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    const sample = parseBrowserSample(JSON.parse(body));
    if (!sample) return new Response(null, { status: 400, headers });
    const client = await createClient();
    const { data: { user } } = await client.auth.getUser();
    if (!user) return new Response(null, { status: 401, headers });
    console.info(JSON.stringify({ event: "sandra.browser-performance", version: 1,
      receivedAt: new Date().toISOString(), ...sample,
      deployment: /^[a-f0-9]{40}$/.test(process.env.VERCEL_GIT_COMMIT_SHA ?? "") ? process.env.VERCEL_GIT_COMMIT_SHA : "local",
    }));
    return new Response(null, { status: 204, headers });
  } catch {
    return new Response(null, { status: 400, headers });
  }
}
