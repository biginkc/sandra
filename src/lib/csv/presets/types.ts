/**
 * Vendor-format preset interface.
 *
 * A `VendorPreset` is a pure-logic adapter for one external CSV/Excel
 * schema family (PropStream, TitlePro/DataTree, REISift, etc). It owns
 * two responsibilities:
 *
 *   - `detect(headers, sampleRows)` — fingerprint the file by its headers
 *     (and optionally a few sample rows). Returns a confidence score 0..1.
 *
 *   - `transform(rows, headers)` — pure, deterministic reshape that emits
 *     wizard-ready rows + headers and a stats summary. Composes helpers
 *     from `lib/csv/normalize.ts` — never reimplements them.
 *
 * Mirrors the existing `lib/csv/reshape-d4d.ts` style: pure functions,
 * deterministic, no I/O, no React. Adding a vendor = new file under
 * `lib/csv/presets/` + push to the registry in `index.ts`.
 */
import type { LeadSource } from "@/lib/leads/sources";

export type VendorPresetId =
  | "propstream"
  | "titlepro"
  | "reisift"
  | "bmh_outreach"
  | "permits"
  | "cnam";

export type DetectionResult = {
  id: VendorPresetId;
  /** 0..1 — see thresholds in `index.ts`. ≥ 0.7 fires the banner. */
  confidence: number;
  /** Human-readable reasons rendered in the banner (e.g.
   *  "Phone 1 Type + Method of Add headers present"). */
  reasons: string[];
  /** Optional sub-classification, e.g. "titlepro-lis-pendens". */
  subtype?: string;
};

export type TransformStats = {
  rowsIn: number;
  rowsOut: number;
  rowsCollapsedDup: number;
  columnsAdded: string[];
  columnsRemoved: string[];
  /** Plain-language notes shown in the banner (e.g. "Folded 5 phones
   *  into 3 slots; DNC entries dropped first"). */
  notes: string[];
};

export type TransformResult = {
  rows: Record<string, string>[];
  headers: string[];
  stats: TransformStats;
  /** Wizard-state hints the caller may apply atomically alongside the
   *  transform (e.g. set source dropdown, propose list name). */
  suggestions?: {
    listNameSuggestion?: string;
    /** Constrained to the canonical `LEAD_SOURCES` set so the wizard's
     *  Source dropdown can accept it without further validation. */
    sourceSuggestion?: LeadSource;
    tags?: string[];
  };
};

export type VendorPreset = {
  id: VendorPresetId;
  /** User-facing label shown in banner + helper dialog. */
  label: string;
  /** One-sentence description for the helper dialog. */
  description: string;
  /** Whether this preset's files are lead-import sources. `false` for
   *  Permits + CNAM — banner shows but no transform fires. */
  importable: boolean;
  /** Bumped when the transform changes meaningfully — recorded in
   *  `csv_imports.input_params.preset` so an audit can replay. */
  version: number;
  detect(
    headers: readonly string[],
    sampleRows: readonly Record<string, string>[],
  ): DetectionResult | null;
  transform(
    rows: Record<string, string>[],
    headers: readonly string[],
  ): TransformResult;
  /** Optional blank-template shape exposed by the helper dialog's
   *  "Download blank template" button. */
  template?: {
    headers: string[];
    rows: Record<string, string>[];
  };
};
