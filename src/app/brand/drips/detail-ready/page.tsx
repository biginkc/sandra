import { DripDetailView } from "@/app/(dashboard)/sequences/[id]/detail-view";
import { DripsBrandFrame } from "../_frame";
import { sampleSequences } from "../_sample";
import { sampleDetail } from "../_sample-detail";

export default function BrandDripDetailReady() {
  return <DripsBrandFrame><DripDetailView detail={{ ...sampleDetail, people: [], peopleCount: 0,
    sequence: { ...sampleDetail.sequence, name: "First touch new lead" } }} sources={sampleSequences} isAdmin /></DripsBrandFrame>;
}
