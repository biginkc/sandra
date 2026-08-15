"use client";

import { Download, ShieldBan } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { rowsForGroup, type PreflightGroup } from "@/lib/csv/preflight";
import { serializeReviewedDataset } from "@/lib/csv/dataset";

import type { WizardState } from "../wizard";

export function StepPreflight({ state }: { state: WizardState }) {
  const preflight = state.preflight;
  if (!preflight) return null;

  const download = (group: PreflightGroup) => {
    const rows = rowsForGroup(state.rows, preflight.groups[group]);
    const csv = serializeReviewedDataset(rows, state.headers);
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${(state.filename ?? "import").replace(/\.[^.]+$/, "")}.${group}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const metrics: Array<[string, number, PreflightGroup | null]> = [
    ["Total rows", preflight.total, null],
    ["Ready", preflight.ready, null],
    ["Existing matches", preflight.existingMatches, "existing"],
    ["In-file duplicates", preflight.inFileDuplicates, "duplicates"],
    ["Empty", preflight.empty, "empty"],
    ["Malformed", preflight.malformed, "malformed"],
    ["No usable contact", preflight.noUsableContact, "noUsableContact"],
  ];

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Preflight check</CardTitle>
          <CardDescription>
            Counted on the exact dataset that will import. Nothing is written yet.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {metrics.map(([label, count, group]) => (
            <div key={label} className="border-border rounded-xl border p-4">
              <div className="text-muted-foreground text-xs font-semibold uppercase tracking-wider">
                {label}
              </div>
              <div className="mt-1 text-2xl font-bold tabular-nums">
                {count.toLocaleString()}
              </div>
              {group && count > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-2 h-auto px-0 text-xs"
                  onClick={() => download(group)}
                >
                  <Download className="size-3.5" /> Download rows
                </Button>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      {preflight.dnc > 0 && (
        <div className="bg-foreground text-background flex items-start gap-3 rounded-xl p-4">
          <ShieldBan className="mt-0.5 size-5 shrink-0" />
          <div className="flex-1 text-sm leading-relaxed">
            <strong>{preflight.dnc.toLocaleString()} Do-Not-Contact records detected.</strong>{" "}
            They import as locked, non-actionable Prospects for compliance history.
            This count follows you to the final confirmation — it never disappears.
          </div>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 border-background/40 bg-transparent text-background hover:bg-background/10 hover:text-background"
            onClick={() => download("dnc")}
          >
            <Download className="size-3.5" /> Download
          </Button>
        </div>
      )}
    </div>
  );
}
