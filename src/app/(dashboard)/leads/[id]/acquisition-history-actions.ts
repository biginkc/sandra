"use server";
import { createClient } from "@/lib/supabase/server";
import type {
  AcquisitionHistoryCursor,
  AcquisitionHistoryPage,
  AcquisitionHistoryResult,
} from "@/lib/leads/acquisition-history";
export async function loadLeadAcquisitionHistory(
  propertyId: string,
  cursor: AcquisitionHistoryCursor | null = null,
): Promise<AcquisitionHistoryResult> {
  try {
    const client = await createClient();
    const { data, error } = await (
      client as unknown as {
        rpc: (
          name: string,
          input: Record<string, unknown>,
        ) => Promise<{ data: AcquisitionHistoryPage | null; error: unknown }>;
      }
    ).rpc("fn_get_lead_acquisition_history", {
      p_property_id: propertyId,
      p_limit: 50,
      p_before_at: cursor?.at ?? null,
      p_before_kind: cursor?.kind ?? null,
      p_before_id: cursor?.id ?? null,
    });
    if (error || !data)
      return {
        ok: false,
        message:
          "Outreach and offer history could not be loaded. Retry to retrieve these records.",
      };
    return { ok: true, page: data };
  } catch {
    return {
      ok: false,
      message:
        "Outreach and offer history could not be loaded. Retry to retrieve these records.",
    };
  }
}
