import { NextResponse } from "next/server";

import { createCallbackTimeProviderFromEnv } from "@/lib/norma/callback-time-ai";
import { dispatchNormaCall } from "@/lib/norma/dispatch";
import { handleBlandCallWebhook } from "@/lib/norma/webhook";
import { createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 30;

/** Bland post-call webhook for Norma. See `handleBlandCallWebhook`. */
export async function POST(request: Request): Promise<NextResponse> {
  const client = createAdminClient();
  const result = await handleBlandCallWebhook(request, {
    client,
    dispatch: (requestId) => dispatchNormaCall(requestId, { client }),
    secret: process.env.NORMA_BLAND_WEBHOOK_SECRET,
    callbackTimeProvider: createCallbackTimeProviderFromEnv(),
  });
  return NextResponse.json(result.body, { status: result.status });
}
