import { DripDetailView } from "@/app/(dashboard)/sequences/[id]/detail-view";
import { DripsBrandFrame } from "../_frame";
import { sampleSequences } from "../_sample";
import { sampleDetail } from "../_sample-detail";

export default function BrandDripDetail() {
  return <DripsBrandFrame><DripDetailView detail={sampleDetail} sources={sampleSequences} isAdmin /></DripsBrandFrame>;
}
