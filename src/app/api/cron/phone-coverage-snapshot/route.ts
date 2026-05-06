import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import { capturePhoneCoverageSnapshot } from "@/lib/metrics/phone-coverage";
import type { Database } from "@/lib/supabase/types";

/**
 * Daily phone-coverage-snapshot cron. Vercel invokes the path on its
 * schedule (see vercel.json) with `Authorization: Bearer $CRON_SECRET`.
 * Runs with the service-role client so it can bypass RLS when counting
 * properties and writing to metric_snapshots.
 *
 * Returns `{ ok, numerator, denominator }` on success; 401 on bad secret;
 * 500 on DB error (Vercel retries on 5xx — the upsert is idempotent).
 */

function buildServiceRoleClient() {
  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.TEST_SUPABASE_URL;
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
    const result = await capturePhoneCoverageSnapshot(supabase);
    return NextResponse.json({
      ok: true,
      numerator: result.numerator,
      denominator: result.denominator,
    });
  } catch (e) {
    reportError(e, { tags: { surface: "cron_phone_coverage_snapshot" } });
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown" },
      { status: 500 },
    );
  }
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
