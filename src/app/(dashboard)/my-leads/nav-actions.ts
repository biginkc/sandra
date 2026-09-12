"use server";

import { getAcquisitionBadge } from "@/lib/my-leads/queries";

export async function refreshMyLeadsBadge(): Promise<
  | { ok: true; count: number }
  | { ok: false }
> {
  try {
    return { ok: true, count: await getAcquisitionBadge() };
  } catch {
    return { ok: false };
  }
}
