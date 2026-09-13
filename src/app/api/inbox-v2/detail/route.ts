import { createClient } from "@/lib/supabase/server";
import { getSingleActiveMembership } from "@/lib/auth/memberships";
import { validateInboxReadRequest } from "@/lib/inbox-v2/read-contract";
import { readInboxDetail } from "@/lib/inbox-v2/read-detail";

const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
const failure = (status: number, error: string) => Response.json({ error }, { status, headers });

/** Additive P0 experiment only. Reads never mark messages read. */
export async function GET(request: Request) {
  if (process.env.INBOX_V2_EXPERIMENT_ENABLED !== "1") return failure(404, "Not found");
  try {
    const params = new URL(request.url).searchParams;
    const raw: Record<string, unknown> = {};
    for (const [key, value] of params) {
      if (Object.hasOwn(raw, key) || !["conversationId", "pageSize", "cursor"].includes(key)) return failure(400, "Invalid request");
      raw[key] = key === "pageSize" ? (/^[1-9]\d{0,2}$/.test(value) ? Number(value) : NaN) : value;
    }
    const validated = validateInboxReadRequest(raw);
    if (!validated.ok) return failure(400, "Invalid request");
    const client = await createClient();
    const { data, error } = await client.auth.getUser();
    if (error || !data.user) return failure(401, "Authentication required");
    const membership = await getSingleActiveMembership();
    if (!membership.ok || membership.membership.user_id !== data.user.id) return failure(403, "Access unavailable");
    const result = await readInboxDetail(client, membership.membership.org_id, validated.value);
    if (result.status !== "ready") return failure(result.status === "unavailable" ? 404 : 500, "Conversation unavailable");
    return Response.json(result, { headers });
  } catch {
    // Never reflect exception messages, SQL details, contact data or message content.
    return failure(500, "Conversation unavailable");
  }
}
