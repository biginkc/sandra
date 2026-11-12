import { NextResponse } from "next/server";

import { reportError } from "@/lib/errors/report";
import { captureSendilloSmsHealthSnapshot } from "@/lib/messages/sendillo-health-snapshot";
import { syncProviderCatalog, type CatalogSyncResult } from "@/lib/messaging/delivery";
import { isWithinCreditRefreshWindow } from "@/lib/skip-trace/balance";
import { createAdminClient } from "@/lib/supabase/admin";

async function handle(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET not configured" },
      { status: 500 },
    );
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  if (!isWithinCreditRefreshWindow(now)) {
    return NextResponse.json({ ok: true, skipped: "outside_business_window" });
  }

  try {
    const admin = createAdminClient();
    const snapshot = await captureSendilloSmsHealthSnapshot(admin, now);
    const catalogSync = await syncSenderCatalog(admin);
    return NextResponse.json({
      ok: true,
      capturedAt: snapshot.updatedAt,
      ...(catalogSync ? { catalogSync } : {}),
    });
  } catch (error) {
    reportError(error, { tags: { surface: "cron_sendillo_health_snapshot" } });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "unknown" },
      { status: 500 },
    );
  }
}

/**
 * Keep the sender catalog (and so the "sendable" rule) fresh: the read-only
 * Sendillo number sync also runs on this cron, scoped to the configured
 * Sendillo org. A sync failure is reported but never fails the snapshot.
 */
async function syncSenderCatalog(
  admin: ReturnType<typeof createAdminClient>,
): Promise<CatalogSyncResult | { error: string } | null> {
  const orgId = process.env.SENDILLO_ORG_ID?.trim();
  if (!orgId) return null;
  try {
    return await syncProviderCatalog(admin, orgId);
  } catch (error) {
    reportError(error, { tags: { surface: "cron_sendillo_catalog_sync" } });
    return { error: error instanceof Error ? error.message : "unknown" };
  }
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
