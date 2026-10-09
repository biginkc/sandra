import { NextResponse } from "next/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

import { sweepLateSends } from "@/lib/ai-responder/dispatch";
import { sweepTemplateSentClaims } from "@/lib/ai-responder/template-claims";
import { reportError } from "@/lib/errors/report";
import { sweepStalePipelineRuns } from "@/lib/pipeline-runs";
import type { Database } from "@/lib/supabase/types";

/**
 * Vercel cron → `/api/cron/sweep-stale-pipeline-runs` every ten minutes.
 * Marks pipeline runs stuck in `running` for 30+ minutes as `error`
 * (reason `stale_running`) so the feed never shows a run in flight forever.
 * Also finishes any late-send reconciliation (provider accepted a reply after
 * the send timeout) whose in-process `after()` hook never ran, and flags any
 * dispatch claim that sent an approved template but never applied its outcome
 * (`template_sent_outcome_missing`).
 */
export const maxDuration = 60;

const STALE_AFTER_MINUTES = 30;

function createServiceRoleClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("pipeline-run sweep needs Supabase service credentials.");
  return createSupabaseClient<Database>(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function handle(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const client = createServiceRoleClient();
    const result = await sweepStalePipelineRuns(client, {
      olderThanMinutes: STALE_AFTER_MINUTES,
    });
    const lateSends = await sweepLateSends(client);
    const templateClaims = await sweepTemplateSentClaims(client);
    return NextResponse.json({ ok: true, ...result, lateSends, templateClaims });
  } catch (error) {
    reportError(error, { tags: { surface: "cron_sweep_stale_pipeline_runs" } });
    return NextResponse.json({ error: error instanceof Error ? error.message : "unknown" }, { status: 500 });
  }
}

export { handle as GET, handle as POST };
