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
