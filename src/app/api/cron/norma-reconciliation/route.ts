import { NextResponse } from "next/server";

import { reportError } from "@/lib/errors/report";
import { createCallbackTimeProviderFromEnv } from "@/lib/norma/callback-time-ai";
import { createBlandClient } from "@/lib/norma/bland";
import { readNormaBlandConfig } from "@/lib/norma/config";
import { dispatchNormaCall } from "@/lib/norma/dispatch";
import { reconcileNormaCalls } from "@/lib/norma/reconcile";
import { readNormaMaintenanceHold } from "@/lib/norma/maintenance";
import { createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 60;

/**
 * Norma reconciliation (PLAN section 6). Resolves stranded / uncertain call
 * requests by looking calls up in Bland. Never redials a call that may exist
 * and never resumes a drip on ambiguity. needs_review rows are rechecked only
 * in the first five minutes of each hour (slower cadence than the 5-minute cron).
 */
async function handle(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (readNormaMaintenanceHold()) {
    return NextResponse.json({ ok: true, maintenanceHeld: true });
  }
  try {
    const admin = createAdminClient();
    const blandConfig = readNormaBlandConfig();
    const summary = await reconcileNormaCalls({
      client: admin,
      bland: blandConfig ? createBlandClient(blandConfig) : null,
      dispatch: (requestId) => dispatchNormaCall(requestId, { client: admin }),
      includeNeedsReview: new Date().getUTCMinutes() < 5,
      callbackTimeProvider: createCallbackTimeProviderFromEnv(),
    });
    return NextResponse.json({ ok: summary.errors === 0, ...summary }, { status: summary.errors === 0 ? 200 : 500 });
  } catch (error) {
    reportError(error, { tags: { surface: "cron_norma_reconciliation" } });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
