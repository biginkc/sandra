"use client";

import { CheckCircle2, Download, Sparkles, UploadCloudIcon } from "lucide-react";
import Papa from "papaparse";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";

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
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { ListCombobox } from "../list-combobox";
import type {
  WizardAction,
  WizardMarket,
  WizardSource,
  WizardState,
} from "../wizard";

const SOURCES: { value: WizardSource; label: string }[] = [
  { value: "dealmachine", label: "DealMachine" },
  { value: "propstream", label: "PropStream" },
  { value: "driving_for_dollars", label: "Driving for dollars" },
  { value: "referral", label: "Referral" },
  { value: "cold_call", label: "Cold call" },
  { value: "sms", label: "SMS (inbound)" },
  { value: "web_form", label: "Web form" },
  { value: "direct_mail", label: "Direct mail" },
];

const MARKETS: { value: WizardMarket; label: string }[] = [
  { value: "Kansas City", label: "Kansas City" },
  { value: "St. Louis", label: "St. Louis" },
  { value: "Dayton", label: "Dayton" },
  { value: "Lake of the Ozarks", label: "Lake of the Ozarks" },
];

// A typical DealMachine monthly export is ~10 MB / ~20K rows. Hard-block
// set high enough to accommodate that, with a soft warn on anything that
// will noticeably stall the in-browser parse. When we move parsing to
// Supabase Storage + an Edge Function, both limits can lift further.
const SOFT_WARN_BYTES = 15 * 1024 * 1024; // 15 MB
const HARD_BLOCK_BYTES = 50 * 1024 * 1024; // 50 MB

type Props = { state: WizardState; dispatch: React.Dispatch<WizardAction> };

export function StepUpload({ state, dispatch }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);

  const handleFile = (file: File | null) => {
    if (!file) return;

    if (file.size > HARD_BLOCK_BYTES) {
      toast.error(
        `File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). ` +
          `Max ${HARD_BLOCK_BYTES / 1024 / 1024} MB in-browser — split into batches ` +
          "or wait for the bulk-upload pipeline.",
      );
      return;
    }
    if (file.size > SOFT_WARN_BYTES) {
      toast.warning(
        `Large file (${(file.size / 1024 / 1024).toFixed(1)} MB). Parsing may take a moment.`,
      );
    }

    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: "greedy",
      dynamicTyping: false,
      transformHeader: (h) => h.trim(),
      complete: (results) => {
        const headers = (results.meta.fields ?? []).filter(Boolean);
        if (headers.length === 0) {
          toast.error("CSV has no headers — check the file and try again.");
          return;
        }
        const rows = results.data.filter(
          (r) =>
            r && typeof r === "object" &&
            Object.values(r).some((v) => v != null && String(v).trim() !== ""),
        );
        dispatch({
          type: "FILE_PARSED",
          file,
          filename: file.name,
          headers,
          rows,
        });
        toast.success(`Parsed ${rows.length} rows from ${file.name}.`);
      },
      error: (err) => {
        toast.error(`Parse error: ${err.message}`);
      },
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Upload CSV</CardTitle>
        <CardDescription>
          Pick your export, then choose the source and target market.
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
              const looksLikeCsv =
                /\.csv$/i.test(file.name) ||
                file.type === "text/csv" ||
                file.type === "application/vnd.ms-excel" ||
                file.type === "";
              if (!looksLikeCsv) {
                toast.error(
                  `That doesn't look like a CSV (${file.type || file.name}).`,
                );
                return;
              }
              handleFile(file);
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
                      : "Drag a CSV here, or click to browse"}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    .csv up to {HARD_BLOCK_BYTES / 1024 / 1024} MB
                  </span>
                </div>
              </>
            )}
            <input
              id="file"
              ref={inputRef}
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
            />
          </label>
        </div>

        <PrecheckPanel state={state} dispatch={dispatch} />

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
        </div>

        <div className="flex flex-col gap-2">
          <Label>Market</Label>
          <Select
            value={state.market ?? ""}
            onValueChange={(v) =>
              dispatch({ type: "SET_MARKET", market: v as WizardMarket })
            }
          >
            <SelectTrigger>
              <SelectValue placeholder="Pick a market…" />
            </SelectTrigger>
            <SelectContent>
              {MARKETS.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  {m.label}
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
            Every imported row — including duplicates we dedupe against
            existing properties — gets added to this list. Re-importing the
            same address into a different list is how you <em>stack</em>: a
            property on Absentee + Pre-Foreclosure + Tired Landlord is a
            stronger motivation signal than any one list. Search to pick an
            existing list or type a new name to create one.
          </p>
        </div>
      </CardContent>
    </Card>
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
