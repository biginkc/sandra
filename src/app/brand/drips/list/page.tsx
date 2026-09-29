import { DripsOverview } from "@/app/(dashboard)/sequences/overview-view";
import { DripsBrandFrame } from "../_frame";
import { sampleNeedsRows, sampleSequences } from "../_sample";

export default function BrandDripsList() {
  return <DripsBrandFrame><DripsOverview archived={false} isAdmin sequencesResult={{ ok: true, data: sampleSequences }} needsResult={{ ok: true, data: sampleNeedsRows }} /></DripsBrandFrame>;
}
