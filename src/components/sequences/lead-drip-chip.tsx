import { Droplet } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { DripProgress } from "@/lib/sequences/drip-progress";

export function LeadDripChip({ drip }: { drip: DripProgress | null }) {
  if (drip?.status !== "Waiting") return null;
  return <Badge variant="outline" className="gap-1 border-sky-200 bg-sky-50 text-[10px] text-sky-800" data-testid={`lead-drip-chip-${drip.propertyId}`}><Droplet className="size-3" />Drip · {drip.step} of {drip.totalSteps}</Badge>;
}
