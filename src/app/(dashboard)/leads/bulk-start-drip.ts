import type { DripResult } from "@/lib/sequences/start-drip";
import { startDripForLeads } from "@/app/(dashboard)/sequences/actions";

export type BulkDripResult = DripResult & { address: string };

export async function startBulkDrip(
  sequenceId: string,
  leads: { id: string; address: string }[],
  onProgress: (done: number) => void,
  start = startDripForLeads,
): Promise<BulkDripResult[]> {
  const results: BulkDripResult[] = [];
  for (let offset = 0; offset < leads.length; offset += 100) {
    const chunk = leads.slice(offset, offset + 100);
    try {
      const response = await start(sequenceId, chunk.map((lead) => lead.id));
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
    onProgress(results.length);
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
