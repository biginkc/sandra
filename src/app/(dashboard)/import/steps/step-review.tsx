"use client";

import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Download,
  Info,
} from "lucide-react";
import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { buildInvalidRowsCsv } from "@/lib/csv/invalid-rows-csv";
import {
  groupRowIssues,
  type RowIssueGroup,
} from "@/lib/csv/row-issues";
import { validateRow } from "@/lib/csv/validate";
import { cn } from "@/lib/utils";

import type { WizardAction, WizardState } from "../wizard";

type Props = { state: WizardState; dispatch: React.Dispatch<WizardAction> };

const ROWS_VISIBLE_PER_GROUP = 10;
const TOOLTIP_PREVIEW_ROWS = 3;

export function StepReview({ state }: Props) {
  const summary = state.summary;

  // Re-derive validation results across all rows for the breakdown.
  // useMemo keeps it cheap on re-renders; recomputing from state.rows
  // avoids piling more denormalized arrays into wizard state.
  const breakdown = useMemo(() => {
    const validated = state.rows.map((row, i) =>
      validateRow(row, state.mapping, i),
    );
    return groupRowIssues(validated);
  }, [state.rows, state.mapping]);

  const handleDownloadInvalid = () => {
    const validated = state.rows.map((row, idx) =>
      validateRow(row, state.mapping, idx),
    );
    const csv = buildInvalidRowsCsv(state.rows, state.mapping, validated);
    const baseName = (state.filename ?? "import").replace(/\.csv$/i, "");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${baseName}.invalid-rows.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const totalRows = summary?.totalRows ?? 0;
  const validRows = summary?.validRows ?? 0;
  const invalidRows = summary?.invalidRows ?? 0;
  // Warning row count: a single row may trigger multiple warning rules
  // (e.g. no_phone + no_mailing_address). Take the max group size as the
  // unique-row count rather than summing — same rule of thumb dashboards
  // use to avoid double-counting people across health flags.
  const warningRowCount = breakdown.warnings.reduce(
    (acc, g) => Math.max(acc, g.totalCount),
    0,
  );

  return (
    <TooltipProvider delay={200}>
      <div className="flex flex-col gap-6">
        {/* Row 1 — KPI tiles */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <KpiTile
            label="Will import"
            value={`${validRows.toLocaleString()} of ${totalRows.toLocaleString()}`}
            sublabel={validRows === 1 ? "row" : "rows"}
          />
          <KpiTile
            label="Blocked"
            value={invalidRows.toLocaleString()}
            sublabel={
              invalidRows === 1
                ? "row · won't import"
                : "rows · won't import"
            }
            tone={invalidRows > 0 ? "destructive" : "neutral"}
          />
          <KpiTile
            label="Warnings"
            value={warningRowCount.toLocaleString()}
            sublabel={
              warningRowCount === 1
                ? "row · still imports"
                : "rows · still import"
            }
            tone={warningRowCount > 0 ? "warning" : "neutral"}
          />
        </div>

        {/* Row 2 — Blocker section */}
        {breakdown.blockers.length > 0 && (
          <section>
            <header className="border-destructive/40 mb-3 flex items-center justify-between gap-3 border-t-2 pt-3">
              <div className="flex items-center gap-2">
                <AlertCircle className="text-destructive size-4" />
                <span className="text-destructive text-xs font-bold tracking-widest uppercase">
                  Won&apos;t import — fix or skip
                </span>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleDownloadInvalid}
                className="gap-1.5 text-xs"
              >
                <Download className="size-3.5" />
                Download {invalidRows.toLocaleString()}{" "}
                {invalidRows === 1 ? "row" : "rows"}
              </Button>
            </header>
            <ul className="divide-border border-border divide-y rounded-md border">
              {breakdown.blockers.map((g) => (
                <IssueRow key={g.ruleKey} group={g} />
              ))}
            </ul>
          </section>
        )}

        {/* Row 3 — Warning section */}
        {breakdown.warnings.length > 0 && (
          <section>
            <header className="border-border mb-3 flex items-center gap-2 border-t pt-3">
              <Info className="text-muted-foreground size-4" />
              <span className="text-muted-foreground text-xs font-bold tracking-widest uppercase">
                Heads up — these still import
              </span>
            </header>
            <ul className="divide-border border-border divide-y rounded-md border">
              {breakdown.warnings.map((g) => (
                <IssueRow key={g.ruleKey} group={g} />
              ))}
            </ul>
          </section>
        )}

        {/* Existing preview (first 10 rows) */}
        <Card>
          <CardHeader>
            <CardTitle>Preview (first 10 rows)</CardTitle>
            <CardDescription>
              Each row shows validation status and the first error, if any.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="border-border rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[70px]">Status</TableHead>
                    <TableHead>Address</TableHead>
                    <TableHead>Error (if any)</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {state.previewRows.map((r) => (
                    <TableRow key={r.rowIndex}>
                      <TableCell>
                        <Badge variant={r.ok ? "default" : "destructive"}>
                          {r.ok ? "valid" : "error"}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-medium">
                        {String(r.normalized.address ?? "—")}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {r.errors[0]?.message ?? ""}
                      </TableCell>
                    </TableRow>
                  ))}
                  {state.previewRows.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={3}
                        className="text-muted-foreground py-6 text-center"
                      >
                        No rows to preview.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>
    </TooltipProvider>
  );
}

function KpiTile({
  label,
  value,
  sublabel,
  tone = "neutral",
}: {
  label: string;
  value: string;
  sublabel: string;
  tone?: "neutral" | "destructive" | "warning";
}) {
  return (
    <div
      className={cn(
        "border-border bg-card rounded-2xl border px-6 py-5",
        tone === "destructive" && "border-destructive/40 bg-destructive/5",
        tone === "warning" &&
          "border-amber-300 bg-amber-50 dark:border-amber-500/40 dark:bg-amber-500/10",
      )}
    >
      <div
        className={cn(
          "text-[11px] font-bold tracking-widest uppercase",
          tone === "destructive"
            ? "text-destructive"
            : tone === "warning"
              ? "text-amber-700 dark:text-amber-400"
              : "text-muted-foreground",
        )}
      >
        {label}
      </div>
      <div className="text-foreground mt-2 text-4xl font-extrabold tracking-tight tabular-nums">
        {value}
      </div>
      <div className="text-muted-foreground mt-2 text-xs">{sublabel}</div>
    </div>
  );
}

function IssueRow({ group }: { group: RowIssueGroup }) {
  const [expanded, setExpanded] = useState(false);
  const visible = group.rows.slice(0, ROWS_VISIBLE_PER_GROUP);
  const hidden = group.totalCount - visible.length;
  const previewLines = group.rows
    .slice(0, TOOLTIP_PREVIEW_ROWS)
    .map((r) => `Row ${r.rowIndex + 2} — ${r.identifier}`)
    .join("\n");
  const tooltipBody =
    group.totalCount > TOOLTIP_PREVIEW_ROWS
      ? `${previewLines}\n+ ${group.totalCount - TOOLTIP_PREVIEW_ROWS} more`
      : previewLines;

  return (
    <li>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={() => setExpanded((x) => !x)}
              className="hover:bg-muted/30 flex w-full items-center gap-3 px-4 py-3 text-left transition-colors"
              aria-expanded={expanded}
            />
          }
        >
          {expanded ? (
            <ChevronDown className="text-muted-foreground size-4 shrink-0" />
          ) : (
            <ChevronRight className="text-muted-foreground size-4 shrink-0" />
          )}
          <span className="text-foreground flex-1 text-sm font-semibold">
            {group.ruleLabel}
          </span>
          <Info className="text-muted-foreground/60 size-3.5 shrink-0" />
          <span className="text-muted-foreground text-sm tabular-nums">
            {group.totalCount.toLocaleString()}{" "}
            {group.totalCount === 1 ? "row" : "rows"}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-sm whitespace-pre-line">
          {tooltipBody}
        </TooltipContent>
      </Tooltip>
      {expanded && (
        <div className="bg-muted/20 border-border border-t px-4 py-3">
          <ul className="flex flex-col gap-1.5 text-sm">
            {visible.map((r) => (
              <li
                key={r.rowIndex}
                className="text-muted-foreground flex items-baseline gap-3"
              >
                <span className="text-foreground font-mono text-xs tabular-nums">
                  Row {r.rowIndex + 2}
                </span>
                <span className="truncate">{r.identifier}</span>
              </li>
            ))}
          </ul>
          {hidden > 0 && (
            <div className="text-muted-foreground mt-2 text-xs">
              + {hidden.toLocaleString()} more — download the invalid-rows CSV
              for the full list.
            </div>
          )}
        </div>
      )}
    </li>
  );
}
