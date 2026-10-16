import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";

import { getNeedsDecisionQueue } from "../queries";
import { NeedsDecisionList } from "./needs-decision-list";

export const dynamic = "force-dynamic";

export default async function NeedsDecisionPage() {
  const { items, error } = await getNeedsDecisionQueue();

  return (
    <Page>
      <PageHeader
        title="Needs a decision"
        description="Below-threshold or human-gated Jev decisions. Choose the correct outcome directly — review cadence elsewhere never blocks these from being handled."
      />
      {error ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive" data-testid="jev-needs-decision-error">
          Could not load the queue: {error}
        </p>
      ) : (
        <div className="rounded-md border">
          <NeedsDecisionList initialItems={items} />
        </div>
      )}
    </Page>
  );
}
