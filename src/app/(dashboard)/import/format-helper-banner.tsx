"use client";

import { CheckCircle2, Info, Undo2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { DetectionResult, TransformStats } from "@/lib/csv/presets/types";
import { cn } from "@/lib/utils";

type Props = {
  detected: DetectionResult;
  importable: boolean;
  /** Vendor label to render in the banner — pulled from the preset's
   *  `label` field, not the detection result, so the wording stays
   *  consistent with the helper dialog. */
  vendorLabel: string;
  /** Stats from the transform that ran. Null when no transform fired
   *  (non-importable presets). */
  stats: TransformStats | null;
  /** True after the transform was applied. Drives the "Cleaned by …"
   *  vs "Recognized as …" copy + the Undo button. */
  applied: boolean;
  onUndo: () => void;
  onOpenHelp: () => void;
};

export function FormatHelperBanner({
  importable,
  vendorLabel,
  stats,
  applied,
  onUndo,
  onOpenHelp,
}: Props) {
  if (!importable) {
    return (
      <div className="bg-muted/40 text-muted-foreground flex items-start gap-3 rounded-md border p-4">
        <Info className="size-5 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="flex-1 text-sm">
          <div className="text-foreground font-medium">
            Detected: {vendorLabel}
          </div>
          <p className="mt-1 text-xs">
            This isn&apos;t a lead-import source — it belongs in a property /
            phone enrichment flow. We don&apos;t fire any transforms on it,
            and the wizard won&apos;t be able to ingest it as leads.
          </p>
          <div className="mt-2">
            <Button variant="ghost" size="sm" onClick={onOpenHelp}>
              Learn more
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (!applied || !stats) {
    // Importable preset detected but transform hasn't run yet — should
    // be a transient state. Render minimally.
    return null;
  }

  const reshapedColumnCount = stats.columnsAdded.length + stats.columnsRemoved.length;
  const dupNote =
    stats.rowsCollapsedDup > 0
      ? ` · ${stats.rowsCollapsedDup} duplicate${stats.rowsCollapsedDup === 1 ? "" : "s"} collapsed`
      : "";

  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-md border border-emerald-300 bg-emerald-50 p-4",
        "dark:border-emerald-700 dark:bg-emerald-950/40",
      )}
    >
      <CheckCircle2 className="size-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
      <div className="flex-1 text-sm">
        <div className="text-foreground font-medium">
          Recognized as {vendorLabel}
        </div>
        <p className="text-muted-foreground mt-1 text-xs">
          Source set automatically · {stats.rowsIn.toLocaleString()} →{" "}
          {stats.rowsOut.toLocaleString()} rows · {reshapedColumnCount} column
          {reshapedColumnCount === 1 ? "" : "s"} reshaped
          {dupNote}
        </p>
        {stats.notes.length > 0 && (
          <ul className="text-muted-foreground mt-2 list-disc space-y-0.5 pl-5 text-xs">
            {stats.notes.slice(0, 4).map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        )}
        <div className="mt-3 flex gap-2">
          <Button variant="ghost" size="sm" onClick={onOpenHelp}>
            See what we did
          </Button>
          <Button variant="outline" size="sm" onClick={onUndo}>
            <Undo2 className="mr-1 size-3.5" />
            Undo
          </Button>
        </div>
      </div>
    </div>
  );
}
