import { getSequenceAdminStatus } from "./admin";
import { listSequences, listSequenceNeedsPerson } from "./actions";
import { DripsOverview } from "./overview-view";

export default async function SequencesIndexPage({ searchParams }: { searchParams: Promise<{ archived?: string }> }) {
  const archived = (await searchParams).archived === "1";
  const [isAdmin, sequencesResult, needsResult] = await Promise.all([getSequenceAdminStatus(), listSequences(), listSequenceNeedsPerson()]);
  return <DripsOverview archived={archived} isAdmin={isAdmin} sequencesResult={sequencesResult} needsResult={needsResult} />;
}
