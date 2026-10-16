import { NextResponse } from "next/server";

import { reportError } from "@/lib/errors/report";
import { dispatchNormaCall } from "@/lib/norma/dispatch";
import { readNormaQueueConfig } from "@/lib/norma/queue/config";
import { createQueueTickStore, queueResultFromDispatch, runNormaQueueTick } from "@/lib/norma/queue/queue-tick";
import { createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 60;

/**
 * Norma call queue tick (plan "Cron"). Every minute: lease watchdog, reply and block sweeps, then claim -> create ->
 * dispatch until nothing is due, capacity refuses, or ~50 s. With the queue flag off (or its limits invalid) it does
 * nothing at all.
 */
async function handle(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const config = readNormaQueueConfig(process.env);
    if (!config.enabled) return NextResponse.json({ skipped: "disabled" });
    const admin = createAdminClient();
    const summary = await runNormaQueueTick({
      config,
      now: () => Date.now(),
      store: createQueueTickStore(admin),
      dispatch: async (requestId) => queueResultFromDispatch(await dispatchNormaCall(requestId, { client: admin, queueConfig: config })),
    });
    if ("skipped" in summary) return NextResponse.json(summary);
    return NextResponse.json({ ok: summary.errors === 0, ...summary }, { status: summary.errors === 0 ? 200 : 500 });
  } catch (error) {
    reportError(error, { tags: { surface: "cron_norma_queue_tick" } });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
