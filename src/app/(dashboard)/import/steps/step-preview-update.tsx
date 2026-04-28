"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

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
  copyToClipboard,
  downloadCsv,
  rowsToCsv,
} from "@/lib/csv/export";
import { SUB_OPERATIONS_BY_ID } from "@/lib/csv/update-operations";
import type { UpdatePreview } from "@/lib/csv/update-bulk";

import { runUpdatePreviewAction } from "../actions";
import type { WizardAction, WizardState } from "../wizard";

type Props = { state: WizardState; dispatch: React.Dispatch<WizardAction> };

export function StepPreviewUpdate({ state, dispatch }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Run the preview as soon as we land here. The preview is a read-only
  // dry-run, so re-running it is cheap if the user goes Back and changes
  // something.
  useEffect(() => {
    if (!state.subOperation || state.rows.length === 0) return;
    if (state.updatePreview) return; // already loaded
    let cancelled = false;
    setLoading(true);
    setError(null);
    runUpdatePreviewAction({
      subOperationId: state.subOperation,
      rows: state.rows as Record<string, string>[],
    }).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      dispatch({ type: "SET_UPDATE_PREVIEW", preview: result.data });
    });
    return () => {
      cancelled = true;
    };
  }, [state.subOperation, state.rows, state.updatePreview, dispatch]);

  const subOp = state.subOperation
    ? SUB_OPERATIONS_BY_ID[state.subOperation]
    : null;

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Building preview…</CardTitle>
          <CardDescription>
            Matching {state.rows.length} rows against existing properties.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Preview failed</CardTitle>
          <CardDescription className="text-destructive">{error}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const preview = state.updatePreview;
  if (!preview || !subOp) return null;

  return (
    <div className="flex flex-col gap-4">
      <SummaryRow preview={preview} />
      <MatchedBucket preview={preview} />
      <UnmatchedBucket preview={preview} subOpId={subOp.id} />
    </div>
  );
}

function SummaryRow({ preview }: { preview: UpdatePreview }) {
  const matched = preview.matched.length;
  const unmatched = preview.unmatched.length;
  const dup = preview.duplicateAddresses.length;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Preview</CardTitle>
        <CardDescription>
          <span className="text-foreground font-medium">{matched}</span> matched
          ·{" "}
          <span className="text-foreground font-medium">{unmatched}</span>{" "}
          couldn&apos;t match · {preview.totalRows} total rows
          {dup > 0 && (
            <>
              {" "}
              ·{" "}
              <span className="text-amber-600 dark:text-amber-400">
                {dup} duplicate address{dup === 1 ? "" : "es"} (last-write-wins)
              </span>
            </>
          )}
        </CardDescription>
      </CardHeader>
    </Card>
  );
}

function MatchedBucket({ preview }: { preview: UpdatePreview }) {
  const handleExport = () => {
    const rows = preview.matched.map((m) => ({
      row: m.rowIndex + 1,
      address: m.address,
      before: JSON.stringify(m.before),
      after: JSON.stringify(m.after),
    }));
    downloadCsv("matched.csv", rowsToCsv(rows, ["row", "address", "before", "after"]));
  };

  if (preview.matched.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No matches</CardTitle>
          <CardDescription>
            None of the rows in your sheet matched an existing property. Check
            the addresses and try again.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle>Will update — {preview.matched.length} rows</CardTitle>
          <CardDescription>
            Showing first 10 — full list available via Export.
          </CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={handleExport} data-testid="export-matched">
          Export matched
        </Button>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">Row</TableHead>
                <TableHead>Address</TableHead>
                <TableHead>Change</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {preview.matched.slice(0, 10).map((m) => (
                <TableRow key={m.rowIndex}>
                  <TableCell className="text-muted-foreground">
                    {m.rowIndex + 1}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{m.address}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {summarizeDiff(m.before, m.after)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function UnmatchedBucket({
  preview,
  subOpId,
}: {
  preview: UpdatePreview;
  subOpId: string;
}) {
  if (preview.unmatched.length === 0) return null;

  const handleExport = () => {
    const rows = preview.unmatched.map((u) => ({
      row: u.rowIndex + 1,
      address: u.address,
      reason: u.reason,
      detail: u.detail ?? "",
    }));
    downloadCsv(
      "couldnt-match.csv",
      rowsToCsv(rows, ["row", "address", "reason", "detail"]),
    );
  };

  const handleCopyUnknownTags = async () => {
    const ok = await copyToClipboard(preview.unknownTags.join(", "));
    if (ok)
      toast.success(
        `Copied ${preview.unknownTags.length} tag name(s). Paste into the tag-create UI in /leads.`,
      );
    else toast.error("Couldn't copy. Select the list and copy manually.");
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle>
            Couldn&apos;t match — {preview.unmatched.length} rows
          </CardTitle>
          <CardDescription>
            These rows will be skipped on confirm.
          </CardDescription>
        </div>
        <div className="flex gap-2">
          {subOpId === "tag-existing-properties" &&
            preview.unknownTags.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleCopyUnknownTags}
                data-testid="copy-unknown-tags"
              >
                Copy unknown tags ({preview.unknownTags.length})
              </Button>
            )}
          <Button variant="outline" size="sm" onClick={handleExport} data-testid="export-unmatched">
            Export unmatched
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">Row</TableHead>
                <TableHead>Address</TableHead>
                <TableHead>Reason</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {preview.unmatched.slice(0, 10).map((u) => (
                <TableRow key={u.rowIndex}>
                  <TableCell className="text-muted-foreground">
                    {u.rowIndex + 1}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{u.address}</TableCell>
                  <TableCell>
                    <span className="font-mono text-xs">{u.reason}</span>
                    {u.detail && (
                      <span className="text-muted-foreground block text-xs">
                        {u.detail}
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function summarizeDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const parts: string[] = [];
  for (const k of keys) {
    const b = before[k];
    const a = after[k];
    if (b === undefined) parts.push(`${k}=${formatVal(a)}`);
    else parts.push(`${k}: ${formatVal(b)} → ${formatVal(a)}`);
  }
  return parts.join(", ");
}

function formatVal(v: unknown): string {
  if (v === null || v === undefined) return "∅";
  if (Array.isArray(v)) return `[${v.join(", ")}]`;
  return String(v);
}
