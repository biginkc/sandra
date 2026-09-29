import type { DripResult } from "@/lib/sequences/start-drip";
import { startDripForLeads } from "@/app/(dashboard)/sequences/actions";

export type BulkDripResult = DripResult & { address: string };

const STOPPED_REASON = "Stopped: your session ended. Sign in and try again.";

export async function startBulkDrip(
  sequenceId: string,
  leads: { id: string; address: string }[],
  onProgress: (done: number) => void,
  start = startDripForLeads,
): Promise<BulkDripResult[]> {
  const results: BulkDripResult[] = [];
  for (let offset = 0; offset < leads.length; offset += 100) {
    const chunk = leads.slice(offset, offset + 100);
    let sessionEnded = false;
    try {
      const response = await start(sequenceId, chunk.map((lead) => lead.id));
      sessionEnded = !response.ok && (response.error.code === "UNAUTHENTICATED" || response.error.code === "SESSION_EXPIRED");
      const byId = new Map(response.ok ? response.data.results.map((result) => [result.propertyId, result]) : []);
      for (const lead of chunk) {
        const result = byId.get(lead.id);
        results.push({
          propertyId: lead.id,
          address: lead.address,
          status: result?.status ?? "failed",
          reason: result?.reason ?? (response.ok ? "Could not enroll this lead." : response.error.message),
        });
      }
    } catch {
      for (const lead of chunk) results.push({ propertyId: lead.id, address: lead.address, status: "failed", reason: "Could not start the drip." });
    }
    if (sessionEnded) {
      for (const lead of leads.slice(offset + chunk.length)) {
        results.push({ propertyId: lead.id, address: lead.address, status: "failed", reason: STOPPED_REASON });
      }
    }
    onProgress(results.length);
    if (sessionEnded) break;
  }
  return results;
}

export function groupBulkDripResults(results: BulkDripResult[]) {
  const groups = new Map<string, BulkDripResult[]>();
  for (const result of results) {
    if (result.status === "enrolled") continue;
    const key = `${result.status}\u0000${result.reason}`;
    groups.set(key, [...(groups.get(key) ?? []), result]);
  }
  return [...groups.entries()].map(([key, leads]) => ({
    status: key.split("\u0000")[0] as "skipped" | "failed",
    reason: leads[0].reason,
    leads,
  }));
}
