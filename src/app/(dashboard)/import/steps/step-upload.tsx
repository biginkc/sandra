"use client";

import Papa from "papaparse";
import { useRef } from "react";
import { toast } from "sonner";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import type {
  WizardAction,
  WizardMarket,
  WizardSource,
  WizardState,
} from "../wizard";

const SOURCES: { value: WizardSource; label: string }[] = [
  { value: "dealmachine", label: "DealMachine" },
  { value: "zillow", label: "Zillow" },
  { value: "realtor", label: "Realtor.com" },
  { value: "mls", label: "MLS" },
  { value: "generic", label: "Generic" },
];

const MARKETS: { value: WizardMarket; label: string }[] = [
  { value: "Kansas City", label: "Kansas City" },
  { value: "St. Louis", label: "St. Louis" },
  { value: "Dayton", label: "Dayton" },
  { value: "Lake of the Ozarks", label: "Lake of the Ozarks" },
];

const SOFT_WARN_BYTES = 5 * 1024 * 1024; // 5 MB
const HARD_BLOCK_BYTES = 10 * 1024 * 1024; // 10 MB

type Props = { state: WizardState; dispatch: React.Dispatch<WizardAction> };

export function StepUpload({ state, dispatch }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = (file: File | null) => {
    if (!file) return;

    if (file.size > HARD_BLOCK_BYTES) {
      toast.error(
        `File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). ` +
          "Split into smaller batches or wait for the bulk-upload pipeline.",
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
          <Input
            id="file"
            ref={inputRef}
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
          />
          {state.filename && (
            <div className="text-muted-foreground text-sm">
              {state.filename} · {state.rows.length} rows · {state.headers.length}{" "}
              columns
            </div>
          )}
        </div>

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
      </CardContent>
    </Card>
  );
}
