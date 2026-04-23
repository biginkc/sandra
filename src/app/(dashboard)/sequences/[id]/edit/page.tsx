import { notFound } from "next/navigation";

import { getImpactAction, getSequenceWithSteps } from "../../actions";

import { SequenceEditor } from "./editor";

export default async function SequenceEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const result = await getSequenceWithSteps(id);
  if (!result.ok || !result.data) {
    if (result.ok) notFound();
    return (
      <div className="p-6 text-destructive text-sm">
        Failed to load sequence: {result.error.message}
      </div>
    );
  }
  const impactResult = await getImpactAction(id);
  const impact = impactResult.ok
    ? impactResult.data
    : { total_enrolled: 0, scheduled_next_7d: 0 };

  return (
    <div className="p-6">
      <SequenceEditor sequence={result.data} initialImpact={impact} />
    </div>
  );
}
