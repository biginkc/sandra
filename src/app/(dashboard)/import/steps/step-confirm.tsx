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

const SKIP_TRACE_PER_JOB_CAP = 500;
const TRACERFY_CREDITS_PER_LEAD = 1; // batch normal rate

export function StepConfirm({ state, dispatch }: Props) {
  const summary = state.summary;
  const validRows = summary?.validRows ?? 0;
  const estimatedCassCost = (validRows * 0.03).toFixed(2);
  const skipTraceTooLarge = validRows > SKIP_TRACE_PER_JOB_CAP;
  const estimatedSkipTraceCredits = Math.min(
    validRows,
    SKIP_TRACE_PER_JOB_CAP,
  ) * TRACERFY_CREDITS_PER_LEAD;

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

        <div className="border-border mt-2 flex items-start gap-2 rounded-md border p-3">
          <input
            id="request-skip-trace"
            type="checkbox"
            checked={state.requestSkipTrace}
            disabled={skipTraceTooLarge}
            onChange={(e) =>
              dispatch({
                type: "SET_REQUEST_SKIP_TRACE",
                requestSkipTrace: e.target.checked,
              })
            }
            className="mt-0.5"
          />
          <label htmlFor="request-skip-trace" className="flex-1 text-sm">
            <span className="font-medium">
              Also request skip-trace for these properties
            </span>
            {skipTraceTooLarge ? (
              <span className="text-muted-foreground block text-xs">
                Imports over {SKIP_TRACE_PER_JOB_CAP} rows can&apos;t request
                skip-trace inline — use the bulk action on /properties in
                batches after import.
              </span>
            ) : (
              <span className="text-muted-foreground block text-xs">
                Off by default. Tracerfy charges ~{estimatedSkipTraceCredits}{" "}
                credits for this batch ({TRACERFY_CREDITS_PER_LEAD}/lead). Goes
                through admin approval if you&apos;re not an admin.
              </span>
            )}
          </label>
        </div>
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
