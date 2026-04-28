"use client";

import { UploadCloudIcon } from "lucide-react";
import Papa from "papaparse";
import { useRef, useState } from "react";
import { toast } from "sonner";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { SUB_OPERATIONS_BY_ID } from "@/lib/csv/update-operations";

import { ExampleTemplateDialog } from "../example-template-dialog";
import type { WizardAction, WizardState } from "../wizard";

const SOFT_WARN_BYTES = 15 * 1024 * 1024;
const HARD_BLOCK_BYTES = 50 * 1024 * 1024;

type Props = { state: WizardState; dispatch: React.Dispatch<WizardAction> };

export function StepUpdateUpload({ state, dispatch }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const [showExample, setShowExample] = useState(false);

  const subOp = state.subOperation
    ? SUB_OPERATIONS_BY_ID[state.subOperation]
    : null;

  const handleFile = (file: File | null) => {
    if (!file) return;
    if (!subOp) {
      toast.error("Pick an update type first.");
      return;
    }

    if (file.size > HARD_BLOCK_BYTES) {
      toast.error(
        `File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). ` +
          `Max ${HARD_BLOCK_BYTES / 1024 / 1024} MB in-browser — split into batches.`,
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

        const missing = subOp.requiredColumns.filter(
          (c) => !headers.includes(c),
        );
        if (missing.length > 0) {
          toast.error(
            `Missing required column(s): ${missing.join(", ")}. Click "See example" for the expected format.`,
          );
          return;
        }

        const rows = results.data.filter(
          (r) =>
            r &&
            typeof r === "object" &&
            Object.values(r).some((v) => v != null && String(v).trim() !== ""),
        );
        dispatch({
          type: "UPDATE_FILE_PARSED",
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
        <CardTitle>Upload your sheet</CardTitle>
        <CardDescription>
          Updating: <span className="text-foreground font-medium">{subOp?.label}</span>
          {subOp && (
            <>
              {" — needs columns "}
              <code className="font-mono">
                {subOp.requiredColumns.join(", ")}
              </code>
              .{" "}
              <button
                type="button"
                className="text-primary font-medium hover:underline"
                onClick={() => setShowExample(true)}
                data-testid="update-upload-see-example"
              >
                See example
              </button>
              .
            </>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="update-file">CSV file</Label>
          <label
            htmlFor="update-file"
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
              "border-input flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed px-6 py-10 text-center transition-colors",
              dragActive
                ? "border-primary bg-primary/5"
                : "hover:border-foreground/30 hover:bg-muted/30",
            )}
          >
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
            <input
              id="update-file"
              ref={inputRef}
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
            />
          </label>
          {state.filename && (
            <div className="text-muted-foreground text-sm">
              {state.filename} · {state.rows.length} rows · {state.headers.length}{" "}
              columns
            </div>
          )}
        </div>
      </CardContent>

      <ExampleTemplateDialog
        open={showExample}
        onOpenChange={setShowExample}
        subOperation={subOp}
      />
    </Card>
  );
}
