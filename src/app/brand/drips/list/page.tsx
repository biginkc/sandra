import { DripsOverview } from "@/app/(dashboard)/sequences/overview-view";
import { needsPersonPiles } from "@/app/(dashboard)/sequences/overview-model";
import { DripsBrandFrame } from "../_frame";
import { sampleNeedsRows, sampleSequences } from "../_sample";

export default function BrandDripsList() {
  const piles = needsPersonPiles(sampleNeedsRows);
  const counts = { finished_no_reply: piles.finished_no_reply.length, couldnt_send: piles.couldnt_send.length, needs_sequence: piles.needs_sequence.length };
  return <DripsBrandFrame><DripsOverview archived={false} isAdmin sequencesResult={{ ok: true, data: sampleSequences }} needsResult={{ ok: true, data: counts }} /></DripsBrandFrame>;
}
