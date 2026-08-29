"use client";

import { CheckCircle2, Download, Sparkles, UploadCloudIcon } from "lucide-react";
import Papa from "papaparse";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { HelpCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  isPrecheckApplicable,
  precheckRows,
} from "@/lib/csv/precheck";
import { detectVendor, getPresetById } from "@/lib/csv/presets";
import type { VendorPresetId } from "@/lib/csv/presets/types";
import { xlsxBufferToCsvFile } from "@/lib/csv/xlsx-to-csv-file";
import { cn } from "@/lib/utils";
import { LEAD_SOURCES } from "@/lib/leads/sources";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { FormatHelperBanner } from "../format-helper-banner";
import { FormatHelperDialog } from "../format-helper-dialog";
import { ListCombobox } from "../list-combobox";
import type {
  CountyOption,
  WizardAction,
  WizardSource,
  WizardState,
} from "../wizard";

const SOURCE_LABELS: Record<WizardSource, string> = {
  dealmachine: "DealMachine",
  propstream: "PropStream",
  titlepro: "TitlePro / DataTree",
  reisift: "REISift / DealMachine Skipped",
  agent_outreach: "BMH Agent Outreach",
  driving_for_dollars: "Driving for dollars",
  referral: "Referral",
  cold_call: "Cold call",
  sms: "SMS (inbound)",
  web_form: "Web form",
  direct_mail: "Direct mail",
};
const SOURCES: { value: WizardSource; label: string }[] = LEAD_SOURCES.map((value) => ({
  value,
  label: SOURCE_LABELS[value],
}));

// The market dropdown was previously driven by a hardcoded MARKETS
// array. Per phase 02 D-01, the counties table is the source of truth
// and the list is now passed in as a prop from the parent server
// component (`import/page.tsx`). Adding a new market is a DB insert,
// not a code change.

// A typical DealMachine monthly export is ~10 MB / ~20K rows. Hard-block
// set high enough to accommodate that, with a soft warn on anything that
// will noticeably stall the in-browser parse. When we move parsing to
// Supabase Storage + an Edge Function, both limits can lift further.
const SOFT_WARN_BYTES = 15 * 1024 * 1024; // 15 MB
const HARD_BLOCK_BYTES = 50 * 1024 * 1024; // 50 MB

type Props = {
  state: WizardState;
  dispatch: React.Dispatch<WizardAction>;
  /** Counties available as markets — fetched server-side in import/page.tsx
   *  per phase 02 D-01 (counties table is the source of truth). */
  counties: CountyOption[];
};

export function StepUpload({ state, dispatch, counties }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [scrollToPresetId, setScrollToPresetId] = useState<VendorPresetId | null>(null);

  const openHelpForCurrent = () => {
    setScrollToPresetId(state.detectedPreset?.id ?? null);
    setHelpOpen(true);
  };
  const openHelpGeneric = () => {
    setScrollToPresetId(null);
    setHelpOpen(true);
  };

  const parseCsvString = (csvString: string, file: File) => {
    Papa.parse<Record<string, string>>(csvString, {
      header: true,
      skipEmptyLines: false,
      dynamicTyping: false,
      transformHeader: (h) => h.trim(),
      complete: (results) => {
        const headers = (results.meta.fields ?? []).filter(Boolean);
        if (headers.length === 0) {
          toast.error("File has no headers — check the file and try again.");
          return;
        }
        const rows = [...results.data];
        // Papa emits one parser-sentinel row for a final newline. Remove
        // only that sentinel; intentional empty records remain visible in
        // Preflight and are conserved through the reviewed dataset.
        const last = rows.at(-1);
        if (
          /\r?\n$/.test(csvString) &&
          last &&
          Object.values(last).every((value) => String(value ?? "").trim() === "")
        ) {
          rows.pop();
        }
        dispatch({
          type: "FILE_PARSED",
          file,
          filename: file.name,
          headers,
          rows,
        });
        toast.success(`Parsed ${rows.length} rows from ${file.name}.`);

        // Format-helper auto-detect: fingerprint the file and, if it
        // matches a known vendor, atomically apply the transform + set
        // the source dropdown. The reducer snapshots pre-state so the
        // user can Undo. Detection is pure-JS, sub-millisecond on the
        // first ~20 sample rows.
        const detection = detectVendor(headers, rows.slice(0, 20));
        if (!detection) return;
        const preset = getPresetById(detection.id);
        if (preset.importable) {
          const transformed = preset.transform(rows, headers);
          dispatch({
            type: "DETECT_AND_APPLY_PRESET",
            detection,
            transformedRows: transformed.rows,
            transformedHeaders: transformed.headers,
            stats: transformed.stats,
            sourceSuggestion: transformed.suggestions?.sourceSuggestion ?? null,
          });
          toast.success(`Recognized ${preset.label} — auto-cleaned.`);
        } else {
          dispatch({
            type: "RECORD_NON_IMPORTABLE_DETECTION",
            detection,
          });
        }
      },
      error: (err: Error) => {
        toast.error(`Parse error: ${err.message}`);
      },
    });
  };

  const handleFile = async (file: File | null) => {
    if (!file) return;

    if (file.size > HARD_BLOCK_BYTES) {
      toast.error(
        `File too large (${Math.round(file.size / 1024 / 1024)} MB). ` +
          `Max ${HARD_BLOCK_BYTES / 1024 / 1024} MB — split the export into batches. Nothing was uploaded.`,
      );
      return;
    }
    if (file.size > SOFT_WARN_BYTES) {
      toast.warning(
        `Large file (${(file.size / 1024 / 1024).toFixed(1)} MB). Parsing may take a moment.`,
      );
    }

    if (/\.xlsx$/i.test(file.name)) {
      try {
        const buffer = await file.arrayBuffer();
        // Convert XLSX → CSV-bytes File. The CSV-bytes File (not the
        // original XLSX File) is what goes into state.file and then up
        // to the csv-imports Storage bucket — so the workflow's
        // server-side papaparse reads CSV bytes back out of Storage,
        // not XLSX binary that masquerades as text/csv.
        const csvFile = xlsxBufferToCsvFile(buffer, file.name);
        const csv = await csvFile.text();
        parseCsvString(csv, csvFile);
      } catch (err) {
        toast.error(
          `Could not read Excel file: ${err instanceof Error ? err.message : "unknown error"}`,
        );
      }
      return;
    }

    // CSV path — read directly as a string so we use the same parseCsvString
    const reader = new FileReader();
    reader.onload = (e) => {
      parseCsvString((e.target?.result as string) ?? "", file);
    };
    reader.onerror = () => toast.error("Could not read file.");
    reader.readAsText(file);
  };

  return (
    <>
    <Card>
      <CardHeader>
        <CardTitle>Upload file</CardTitle>
        <CardDescription>
          .csv or .xlsx, up to 50 MB. Files over 15 MB may take a moment to read.{" "}
          <button
            type="button"
            onClick={openHelpGeneric}
            className="text-primary inline-flex items-center gap-1 underline-offset-2 hover:underline"
          >
            <HelpCircle className="size-3.5" />
            Need help with your input file?
          </button>
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="file">CSV file</Label>
          <label
            htmlFor="file"
            onDragEnter={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setDragActive(true);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (!dragActive) setDragActive(true);
            }}
            onDragLeave={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setDragActive(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setDragActive(false);
              const file = e.dataTransfer.files?.[0] ?? null;
              if (!file) return;
              // Guard against non-CSV drops so a misfire on a PDF doesn't
              // hand garbage to PapaParse.
              const looksLikeSupported =
                /\.(csv|xlsx)$/i.test(file.name) ||
                file.type === "text/csv" ||
                file.type === "application/vnd.ms-excel" ||
                file.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
                file.type === "";
              if (!looksLikeSupported) {
                toast.error(
                  `Unsupported file type (${file.type || file.name}). Use a .csv or .xlsx file.`,
                );
                return;
              }
              void handleFile(file);
            }}
            className={cn(
              "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 px-6 py-10 text-center transition-colors",
              state.filename
                ? "border-emerald-500 bg-emerald-50 dark:border-emerald-500/60 dark:bg-emerald-500/10"
                : cn(
                    "border-input border-dashed",
                    dragActive
                      ? "border-primary bg-primary/5"
                      : "hover:border-foreground/30 hover:bg-muted/30",
                  ),
            )}
          >
            {state.filename ? (
              <>
                <CheckCircle2 className="size-7 text-emerald-600 dark:text-emerald-400" />
                <div className="flex flex-col gap-0.5">
                  <span className="text-foreground text-sm font-semibold">
                    {state.filename}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {state.rows.length.toLocaleString()} rows ·{" "}
                    {state.headers.length} columns · click to choose a different
                    file
                  </span>
                </div>
              </>
            ) : (
              <>
                <UploadCloudIcon
                  className={cn(
                    "size-6",
                    dragActive ? "text-primary" : "text-muted-foreground",
                  )}
                />
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">
                    {dragActive
                      ? "Drop to upload"
                      : "Drag a CSV or Excel file here, or click to browse"}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    .csv or .xlsx up to {HARD_BLOCK_BYTES / 1024 / 1024} MB
                  </span>
                </div>
              </>
            )}
            <input
              id="file"
              ref={inputRef}
              type="file"
              accept=".csv,.xlsx,text/csv"
              className="sr-only"
              onChange={(e) => void handleFile(e.target.files?.[0] ?? null)}
            />
          </label>
        </div>

        {state.detectedPreset && (
          <FormatHelperBanner
            detected={state.detectedPreset}
            importable={getPresetById(state.detectedPreset.id).importable}
            vendorLabel={getPresetById(state.detectedPreset.id).label}
            stats={state.presetStats}
            applied={state.presetApplied}
            onUndo={() => dispatch({ type: "UNDO_PRESET" })}
            onOpenHelp={openHelpForCurrent}
          />
        )}

        <div className="flex flex-col gap-2">
          <Label>Source</Label>
          <Select
            value={state.source ?? ""}
            onValueChange={(v) =>
              dispatch({ type: "SET_SOURCE", source: v as WizardSource })
            }
          >
            <SelectTrigger>
              <SelectValue placeholder="Pick a source…" />
            </SelectTrigger>
            <SelectContent>
              {SOURCES.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-muted-foreground text-xs">
            One approved list — unsupported values are flagged here, never at the end.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <Label>Market</Label>
          <Select
            // Bind to countyId so the dropdown renders the selected
            // county by id. Per project memory
            // `feedback_no_usestate_mirror_of_server_props.md`, the
            // counties prop is rendered directly with no useState mirror.
            value={state.countyId ?? ""}
            onValueChange={(id) => {
              const c = counties.find((x) => x.id === id);
              if (c) {
                dispatch({
                  type: "SET_MARKET",
                  market: c.market,
                  countyId: c.id,
                });
              }
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="Pick a market…">
                {state.countyId
                  ? (counties.find((c) => c.id === state.countyId)?.market ?? "")
                  : null}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {counties.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.market}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-2">
          <Label>List (optional)</Label>
          <ListCombobox
            value={state.listName}
            onChange={(next) =>
              dispatch({ type: "SET_LIST_NAME", listName: next })
            }
          />
          <p className="text-muted-foreground text-xs">
            If a list is chosen, assignment is verified — a failure blocks
            &apos;Completed&apos;, never fails silently.
          </p>
        </div>
      </CardContent>
    </Card>
    <FormatHelperDialog
      open={helpOpen}
      onOpenChange={setHelpOpen}
      scrollToPresetId={scrollToPresetId}
    />
    </>
  );
}

/**
 * Cleanup panel that surfaces above Source/Market when the uploaded file
 * looks like a D4D / Skip Genie export. Offers two non-destructive
 * actions:
 *
 *   - "Drop N empty rows" — replaces the in-memory rows + the File blob
 *     with a smaller version. Empty rows are skip-trace misses that
 *     would silent-skip during ingest anyway; pruning them up front
 *     makes the Progress page show only real work.
 *
 *   - "Download N malformed rows" — extracts rows whose `PROP: Address
 *     Full` couldn't be parsed and downloads them as a separate CSV the
 *     user can triage manually.
 *
 * Intra-file duplicates are deliberately NOT dropped — those rows often
 * carry contact data (relatives, co-owners) that the importer upserts
 * against the matched property. They're shown for awareness only and
 * surface again on the Review screen.
 */
// Retained for Update-mode compatibility while Add mode uses the generalized
// full Preflight step. It is intentionally not rendered in the Add flow.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function PrecheckPanel({
  state,
  dispatch,
}: {
  state: WizardState;
  dispatch: React.Dispatch<WizardAction>;
}) {
  const result = useMemo(() => {
    if (!state.headers.length || !isPrecheckApplicable(state.headers)) {
      return null;
    }
    return precheckRows(state.rows as Record<string, string>[]);
  }, [state.rows, state.headers]);

  if (!result) return null;

  const { stats } = result;
  // Nothing to act on — the panel would be noise.
  if (stats.empty === 0 && stats.unparseable === 0 && stats.intraFileDup === 0) {
    return null;
  }

  const handleDropEmpty = () => {
    if (stats.empty === 0) return;
    const keptRows = [
      ...result.ready,
      ...result.intraFileDups,
      ...result.needsReview,
    ];
    const csv = Papa.unparse(keptRows, { columns: state.headers });
    const newFile = new File([csv], state.filename ?? "import.csv", {
      type: "text/csv",
    });
    dispatch({
      type: "FILE_PARSED",
      file: newFile,
      filename: state.filename ?? "import.csv",
      headers: state.headers,
      rows: keptRows,
    });
    toast.success(`Dropped ${stats.empty.toLocaleString()} empty rows.`);
  };

  const handleDownloadReview = () => {
    if (stats.unparseable === 0) return;
    const csv = Papa.unparse(result.needsReview, { columns: state.headers });
    const baseName = (state.filename ?? "import").replace(/\.csv$/i, "");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${baseName}.needs-review.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="border-border bg-muted/20 flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex items-center gap-2">
        <Sparkles className="text-muted-foreground size-4" />
        <span className="text-foreground text-sm font-semibold">
          File quality check
        </span>
      </div>

      <ul className="text-sm">
        <PrecheckRow
          count={stats.ready}
          label="ready to import as new properties"
          tone="positive"
        />
        {stats.intraFileDup > 0 && (
          <PrecheckRow
            count={stats.intraFileDup}
            label="duplicate of an earlier row · will dedup, contact data still imports"
            tone="info"
          />
        )}
        {stats.empty > 0 && (
          <PrecheckRow
            count={stats.empty}
            label="have no property data · skip-trace misses, safe to drop"
            tone="muted"
          />
        )}
        {stats.unparseable > 0 && (
          <PrecheckRow
            count={stats.unparseable}
            label="have a malformed address · won't import, download to inspect"
            tone="warning"
          />
        )}
      </ul>

      {(stats.empty > 0 || stats.unparseable > 0) && (
        <div className="flex flex-wrap gap-2 pt-1">
          {stats.empty > 0 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleDropEmpty}
              className="gap-1.5 text-xs"
            >
              Drop {stats.empty.toLocaleString()} empty{" "}
              {stats.empty === 1 ? "row" : "rows"}
            </Button>
          )}
          {stats.unparseable > 0 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleDownloadReview}
              className="gap-1.5 text-xs"
            >
              <Download className="size-3.5" />
              Download {stats.unparseable.toLocaleString()} for review
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function PrecheckRow({
  count,
  label,
  tone,
}: {
  count: number;
  label: string;
  tone: "positive" | "info" | "muted" | "warning";
}) {
  return (
    <li className="flex items-baseline gap-3 py-1">
      <span
        className={cn(
          "min-w-[60px] text-right font-mono text-sm font-semibold tabular-nums",
          tone === "positive" && "text-emerald-700 dark:text-emerald-400",
          tone === "warning" && "text-destructive",
          tone === "muted" && "text-muted-foreground",
          tone === "info" && "text-foreground",
        )}
      >
        {count.toLocaleString()}
      </span>
      <span className="text-muted-foreground text-sm">{label}</span>
    </li>
  );
}
