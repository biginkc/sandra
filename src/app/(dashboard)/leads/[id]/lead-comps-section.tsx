import { ProviderDataView } from "@/components/leads/provider-data-view";
import { formatDollars } from "@/lib/calculators/closr-v1";
import { loadLatestLeadComp } from "@/lib/comps";
import { loadProviderData } from "@/lib/comps/provider-data-server";
import { createClient } from "@/lib/supabase/server";

/** Read-only: opening a lead never starts a provider request. */
export async function LeadCompsSection({ propertyId }: { propertyId: string }) {
  const client = await createClient();
  const property = await client.from("properties").select("org_id").eq("id",propertyId).maybeSingle();
  if (property.error || !property.data) return null;
  const latest = await loadLatestLeadComp(client,property.data.org_id,propertyId);
  if (!latest) return null;
  const data = latest.provider === "attom" ? await loadProviderData(client,property.data.org_id,latest.id).catch(() => null) : null;
  return <section className="rounded-xl border bg-card p-4 space-y-3" aria-label="Property valuation and sales" data-testid="lead-comps-section">
    <h2 className="text-sm font-semibold">Property valuation &amp; sales</h2>
    <p className="text-muted-foreground text-xs">{latest.provider === "attom" ? "ATTOM" : "Fixture data"} · Fetched {new Date(latest.fetched_at).toLocaleString("en-US", {timeZone:"America/Chicago"})} CT</p>
    <p className="text-lg font-bold">Automated estimate: {latest.as_is_value == null ? "Unavailable" : formatDollars(Number(latest.as_is_value))}</p>
    {latest.as_is_low != null && latest.as_is_high != null ? <p className="text-sm">Range: {formatDollars(Number(latest.as_is_low))}–{formatDollars(Number(latest.as_is_high))}</p> : null}
    {latest.verify_first ? <p className="text-sm font-medium text-amber-700">Verify before quoting — {Number(latest.comps?.length ?? 0)} priced comps available.</p> : null}
    <p className="text-sm">Owner of record: {latest.owner_of_record ?? "Unknown"}</p>
    <p className="text-xs">Legal description: {latest.legal_description ?? "Unavailable"}</p>
    <ProviderDataView data={data} />
  </section>;
}
