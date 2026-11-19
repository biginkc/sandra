"use server";

import { getAcquisitionBadge } from "@/lib/my-leads/queries";
import { timeServerAction } from "@/lib/perf/server-action-log";

export async function refreshMyLeadsBadge(): Promise<
  | { ok: true; count: number }
  | { ok: false }
> {
  return timeServerAction("refreshMyLeadsBadge", async () => {
    try {
      return { ok: true as const, count: await getAcquisitionBadge() };
    } catch {
      return { ok: false as const };
    }
  });
}
