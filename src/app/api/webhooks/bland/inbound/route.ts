import { NextResponse } from "next/server";
import { handleInboundCall } from "@/lib/norma/inbound";
import { pauseEnrollmentsForInboundCall } from "@/lib/norma/inbound-call-pause";
import { createAdminClient } from "@/lib/supabase/admin";
export const maxDuration = 30;

export async function POST(request: Request) {
  const result = await handleInboundCall(request, {
    secret: process.env.NORMA_BLAND_INBOUND_WEBHOOK_SECRET,
    ingest: async (call) => {
      const admin = createAdminClient();
      const { data, error } = await admin.rpc("fn_norma_ingest_inbound_call", {
        p_call_id: call.callId, p_from: call.from, p_to: call.to,
        p_completed: call.completed, p_recording_state: call.recordingState,
      });
      if (error) throw new Error("Inbound ingestion failed");
      // Seller called back: pause their drips. Throwing makes Bland retry;
      // ingestion and the pause are both idempotent.
      if (data) await pauseEnrollmentsForInboundCall(admin, data);
      return data;
    },
  });
  return NextResponse.json(result.body, { status: result.status });
}
