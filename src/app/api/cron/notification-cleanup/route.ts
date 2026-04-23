import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import { runNotificationCleanup } from "@/lib/notifications/cleanup";
import type { Database } from "@/lib/supabase/types";

/**
 * Daily notification-cleanup cron. Vercel invokes the path on its
 * schedule (see vercel.json) with `Authorization: Bearer $CRON_SECRET`
 * so we can distinguish the real cron from any random POST to the same
 * URL. We run deletes with the service-role client (RLS would filter
 * all rows for an anonymous/authenticated caller).
 *
 * Returns `{ deleted }` on success; 401 on missing/wrong secret; 500 on
 * a DB error (Vercel retries once or twice on 5xx, which is fine — the
 * delete is idempotent).
 */

function buildServiceRoleClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Cron needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.",
    );
  }
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function handle(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET not configured" },
      { status: 500 },
    );
  }
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const supabase = buildServiceRoleClient();
    const result = await runNotificationCleanup(supabase);
    return NextResponse.json({ ok: true, deleted: result.deleted });
  } catch (e) {
    reportError(e, { tags: { surface: "cron_notification_cleanup" } });
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown" },
      { status: 500 },
    );
  }
}

// Vercel cron may send GET or POST depending on project config. Accept
// both so we don't have to care.
export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
