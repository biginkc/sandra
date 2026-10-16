import { NextResponse } from "next/server";
import { handleInboundCall } from "@/lib/norma/inbound";
import { createAdminClient } from "@/lib/supabase/admin";
export const maxDuration = 30;

export async function POST(request: Request) {
  const result = await handleInboundCall(request, {
    secret: process.env.NORMA_BLAND_INBOUND_WEBHOOK_SECRET,
    ingest: async (call) => {
      const { data, error } = await createAdminClient().rpc("fn_norma_ingest_inbound_call", {
        p_call_id: call.callId, p_from: call.from, p_to: call.to,
        p_completed: call.completed, p_recording_state: call.recordingState,
      });
      if (error) throw new Error("Inbound ingestion failed");
      return data;
    },
  });
  return NextResponse.json(result.body, { status: result.status });
}
