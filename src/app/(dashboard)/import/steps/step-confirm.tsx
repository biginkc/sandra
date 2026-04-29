"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

import type { WizardAction, WizardState } from "../wizard";

type Props = { state: WizardState; dispatch: React.Dispatch<WizardAction> };

export function StepConfirm({ state }: Props) {
  const summary = state.summary;
  const validRows = summary?.validRows ?? 0;
  const estimatedCassCost = (validRows * 0.03).toFixed(2);

  // The "Also request skip-trace" checkbox lived here in V1 and rode the
  // legacy after()-callback path. With the workflow runner the action no
  // longer holds a user session at completion time, which the existing
  // requestSkipTrace() needs for the admin/VA approval branching. Easiest
  // fix is to surface the prompt on the StepDone screen instead — once
  // the workflow finishes, the user is still in the wizard and a one-
  // click "skip-trace these N properties" button works the same. Tracked
  // as a follow-up; for now skip-trace happens manually from /properties.

  return (
    <Card>
      <CardHeader>
        <CardTitle>Ready to import</CardTitle>
        <CardDescription>
          Review the summary and click Start Import to begin.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Row label="File" value={state.filename ?? "—"} />
        <Row label="Source" value={state.source ?? "—"} />
        <Row label="Market" value={state.market ?? "—"} />
        <Row
          label="Rows to ingest"
          value={`${validRows} valid of ${summary?.totalRows ?? 0} total`}
        />
        <Row
          label="CASS enrichment"
          value={`Will auto-trigger after ingest · est. $${estimatedCassCost} (not charged today; integration lands in a future session)`}
        />
        <Row
          label="Agent enrichment"
          value="Off by default. Trigger from property detail or batch action after ingest."
        />
      </CardContent>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-4">
      <div className="text-muted-foreground min-w-[140px] text-sm">
        {label}
      </div>
      <div className="text-sm">{value}</div>
    </div>
  );
}
