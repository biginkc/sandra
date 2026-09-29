import { DripDetailView } from "@/app/(dashboard)/sequences/[id]/detail-view";
import { DripsBrandFrame } from "../_frame";
import { sampleSequences } from "../_sample";
import { sampleDetail } from "../_sample-detail";

export default function BrandDripDetailStates() {
  return <DripsBrandFrame><DripDetailView detail={{ ...sampleDetail, sequence: { ...sampleDetail.sequence, id: sampleSequences[4].id, name: "Dead lead requalify", steps: [] }, stats: [], people: [], peopleCount: 0 }} sources={sampleSequences} isAdmin /></DripsBrandFrame>;
}
