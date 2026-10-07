import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { envFlag } from "@/lib/norma/config";
import { reconcileInboundRecordings } from "@/lib/norma/inbound-reconcile";
export const maxDuration=60;
export async function GET(request:Request) {
  const secret=process.env.CRON_SECRET;
  if(!secret)return NextResponse.json({error:"not_configured"},{status:503});
  if(request.headers.get("authorization")!==`Bearer ${secret}`)return NextResponse.json({error:"unauthorized"},{status:401});
  if(!envFlag(process.env.NORMA_INBOUND_RECORDING_RECONCILIATION_ENABLED))return NextResponse.json({status:"disabled"});
  const key=process.env.BLAND_API_KEY?.trim();
  if(!key)return NextResponse.json({error:"not_configured"},{status:503});
  try {return NextResponse.json(await reconcileInboundRecordings(createAdminClient(),key));}
  catch {return NextResponse.json({error:"reconciliation_failed"},{status:500});}
}
