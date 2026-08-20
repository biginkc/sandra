import { NextResponse } from "next/server";

import { reportError } from "@/lib/errors/report";

import { authenticateJitterWriteback } from "../_lib/auth";

// Must match the CAS condition in jitter_claim_dialer_batch (migration
// 20260820100000_jitter_claim_ttl_expiry.sql). If either side's TTL drifts,
// a batch can appear claimable here but still 409 on claim, or vice versa.
const CLAIM_TTL_MINUTES = 30;

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const auth = await authenticateJitterWriteback(request);
    if (!auth.ok) return auth.response;

    const status = new URL(request.url).searchParams.get("status");

    let query = (auth.serviceClient as any)
      .from("dialer_batches")
      .select(
        "id, org_id, title, source_kind, source_meta, status, jitter_session_id, claim_generation, claimed_at, completed_at, created_at, updated_at",
      )
      .eq("org_id", auth.orgId);

    if (status === "pending") {
      // "?status=pending" means *claimable*, not literally status='pending'.
      // A batch whose claim has gone stale (claimed longer than the claim
      // TTL ago, with no reclaim/PATCH since) must still surface here even
      // though its stored `status` column reads 'claimed' — the bridge
      // worker needs to be able to discover and reclaim it. This is a pure,
      // side-effect-free read filter: it never writes `status = 'expired'`
      // or otherwise mutates the row. The actual expiry transition happens
      // only when a claim attempt lands, inside jitter_claim_dialer_batch's
      // matching CAS condition.
      const staleCutoff = new Date(
        Date.now() - CLAIM_TTL_MINUTES * 60 * 1000,
      ).toISOString();
      query = query.or(
        `status.eq.pending,and(status.eq.claimed,claimed_at.lt.${staleCutoff})`,
      );
    } else if (status) {
      query = query.eq("status", status);
    }

    const { data: batches, error } = await query.order("created_at", {
      ascending: true,
    });
    if (error) throw error;

    return NextResponse.json({ batches: batches ?? [] });
  } catch (e) {
    reportError(e, { tags: { surface: "jitter_list_dialer_batches" } });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
