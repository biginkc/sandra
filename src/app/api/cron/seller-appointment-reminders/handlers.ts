import { NextResponse } from "next/server";

import { reportError } from "@/lib/errors/report";
import { cronResponseFailed, runMonitoredCron } from "@/lib/errors/cron-monitor";
import { getConsentState } from "@/lib/messaging/consent";
import { sendSmsToContact } from "@/lib/messaging/send";
import { getMyLeadsFlag } from "@/lib/my-leads/flags";
import { schemaReady } from "@/lib/my-leads/schema-ready";
import {
  runSellerReminderJob,
  type SellerReminderAdmin,
} from "@/lib/my-leads/seller-reminder";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Vercel cron -> `/api/cron/seller-appointment-reminders` every 10 minutes (minute 6, a slot no other
 * cron uses). Sends the seller's morning-of "I'll call you at ..." text for phone appointments.
 *
 * Inert unless the per-org `seller_reminders` flag AND `seller_reminder_settings.enabled` are on (a
 * missing table, row or column reads as off) and the approved copy constant is non-null. The existing
 * rep reminder sweep (`appointment-reminder-sweep`) is a separate cron and is not touched.
 */
async function handle(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return runMonitoredCron(
    "sandra-seller-appointment-reminders",
    { schedule: { type: "crontab", value: "6-59/10 * * * *" }, checkinMargin: 2, maxRuntime: 1 },
    async () => {
      try {
        const supabase = createAdminClient();
        const result = await runSellerReminderJob({
          admin: supabase as unknown as SellerReminderAdmin,
          send: (input) => sendSmsToContact(supabase, input),
          getConsent: (contactId) => getConsentState(supabase, contactId, "sms"),
          getFlag: (orgId) => getMyLeadsFlag(orgId, "seller_reminders"),
          schemaReady: () => schemaReady("seller_reminders"),
          report: (error, surface) => reportError(error, { tags: { surface: `cron_${surface}` } }),
        });
        return NextResponse.json(result);
      } catch (e) {
        reportError(e, { tags: { surface: "cron_seller_appointment_reminders" } });
        return NextResponse.json(
          { error: e instanceof Error ? e.message : "unknown" },
          { status: 500 },
        );
      }
    },
    cronResponseFailed,
  );
}

export const GET = handle;
export const POST = handle;
