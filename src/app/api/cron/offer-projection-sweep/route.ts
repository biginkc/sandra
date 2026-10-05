import { NextResponse } from "next/server";

import { reportError } from "@/lib/errors/report";
import { sweepOfferProjections } from "@/lib/my-leads/offer-projection";

export const maxDuration = 60;

/** Logs offers for contracts the eSign reconciliation confirmed sent, and repairs missed state flips. */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json({ ok: true, ...(await sweepOfferProjections()) });
  } catch (error) {
    reportError(error, { tags: { surface: "cron_offer_projection_sweep" } });
    return NextResponse.json({ error: "offer projection sweep failed" }, { status: 503 });
  }
}
