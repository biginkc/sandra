"use client";

import { useMemo, useReducer, useState } from "react";

import { Button } from "@/components/ui/button";
import { autodetectMapping } from "@/lib/csv/aliases";
import { collectUnlabeledPhones } from "@/lib/csv/line-type-classify";
import type {
  DetectionResult,
  TransformStats,
} from "@/lib/csv/presets/types";
import type { UpdatePreview } from "@/lib/csv/update-bulk";
import { createClient as createBrowserSupabase } from "@/lib/supabase/client";
import type { SubOperationId } from "@/lib/csv/update-operations";
import {
  mappedSections,
  summarize,
  validateRow,
  type ValidatedRow,
  type ValidationSummary,
} from "@/lib/csv/validate";
import { callAction } from "@/lib/errors/call-action";
import { cn } from "@/lib/utils";

import { createImportJob, runBulkUpdateJob } from "./actions";
import { StepConfirm } from "./steps/step-confirm";
import { StepMap } from "./steps/step-map";
import { StepMode } from "./steps/step-mode";
import { StepPreviewUpdate } from "./steps/step-preview-update";
import { StepProgress } from "./steps/step-progress";
import { StepReview } from "./steps/step-review";
import { StepSubOperation } from "./steps/step-suboperation";
import { StepUpdateUpload } from "./steps/step-update-upload";
import { StepUpload } from "./steps/step-upload";

export type WizardStep =
  // Both flows start here.
  | "mode"
  // Add-mode steps (untouched from V1):
  | "upload"
  | "map"
  | "review"
  | "confirm"
  // Update-mode steps:
  | "suboperation"
  | "update-upload"
  | "preview-update"
  // Both flows end here. The Progress step is the terminal screen —
  // its content swaps in-place once the job reaches a terminal status,
  // so there is no separate "Done" step. The earlier two-step
  // (progress → done) flow contradicted the "you can close this tab"
  // copy by also showing a Next button; collapsing the two removes
  // that ambiguity. See `docs/feedback/feedback a.pdf` (item 1).
  | "progress";

export type WizardMode = "add" | "update";

/**
 * Upload the user's CSV to the `csv-imports` Supabase Storage bucket.
 * Object key is `import-{timestamp}-{rand}.csv` — globally unique,
 * sortable, no PII. The workflow runner downloads from this path
 * server-side using the service-role admin client (bypasses bucket RLS).
 *
 * Returns a discriminated union so callers can branch on success/error
 * without juggling try/catch.
 */
async function uploadCsvToStorage(
  file: File,
): Promise<
  | { ok: true; storagePath: string }
  | { ok: false; error: string }
> {
  try {
    const supabase = createBrowserSupabase();
    const { data: memberships, error: membershipError } = await supabase
      .from("memberships")
      .select("org_id")
      .limit(1);
    if (membershipError || !memberships?.[0]?.org_id) {
      return {
        ok: false,
        error:
          "Upload failed: " +
          (membershipError?.message ?? "No organization membership found"),
      };
    }
    const orgId = memberships[0].org_id;
    // Random key — collision odds are vanishing and we never need to
    // look these up by content. Sortable timestamp prefix makes the
    // bucket browsable in the Supabase dashboard.
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const rand = Math.random().toString(36).slice(2, 10);
    const path = `${orgId}/import-${ts}-${rand}.csv`;
    const { error } = await supabase.storage
      .from("csv-imports")
      .upload(path, file, {
        contentType: "text/csv",
        upsert: false,
      });
    if (error) {
      return { ok: false, error: `Upload failed: ${error.message}` };
    }
    return { ok: true, storagePath: path };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Upload failed: ${message}` };
  }
}

// The wizard's source picker now uses the canonical lead-source enum
// shared with the lead webhook + manual entry form (see
// `src/lib/leads/create.ts`). Column mapping is handled separately by
// the `aliases.ts` autodetect — the user no longer needs to identify
// the vendor for mapping purposes; source is purely an attribution
// signal that the user picks deliberately.
import type { LeadSource } from "@/lib/leads/create";
export type WizardSource = LeadSource;

/**
 * One county row, fetched server-side on the parent page (the RSC
 * `import/page.tsx`) and passed in as a prop. Per phase 02 D-01 the
 * counties table is the source of truth for valid markets — there is
 * no compile-time enum any more (the legacy city-shaped union was
 * removed). The dropdown renders `c.market` as the label and uses
 * `c.id` as the select value so the SET_MARKET dispatch can carry
 * both the canonical market string and the county_id FK.
 */
export type CountyOption = {
  id: string;
  name: string;
  state: string;
  market: string;
};

const ADD_STEP_ORDER: readonly WizardStep[] = [
  "mode",
  "upload",
  "map",
  "review",
  "confirm",
  "progress",
];

const UPDATE_STEP_ORDER: readonly WizardStep[] = [
  "mode",
  "suboperation",
  "update-upload",
  "preview-update",
  "progress",
];

const STEP_LABELS: Record<WizardStep, string> = {
  mode: "Mode",
  upload: "Upload",
  map: "Map",
  review: "Review",
  confirm: "Confirm",
  suboperation: "What to update",
  "update-upload": "Upload",
  "preview-update": "Preview",
  progress: "Progress",
};

function stepOrder(mode: WizardMode | null): readonly WizardStep[] {
  if (mode === "update") return UPDATE_STEP_ORDER;
  if (mode === "add") return ADD_STEP_ORDER;
  return ["mode"]; // before mode is picked, the state machine is just the one step
}

/**
 * Step list for the visual progress indicator. The Mode screen is always
 * step zero in the state machine but renders no indicator — the indicator
 * appears once the user clicks Next, starting at "1" with whichever step
 * comes after Mode in the chosen flow.
 *
 * Returns an empty array when on the Mode step; the wizard treats that
 * as "don't render the indicator at all."
 */
export function indicatorOrder(
  step: WizardStep,
  mode: WizardMode | null,
): readonly WizardStep[] {
  if (step === "mode") return [];
  return stepOrder(mode).filter((s) => s !== "mode");
}

export type WizardState = {
  step: WizardStep;
  mode: WizardMode | null;
  /** Update-mode only: which of the 7 sub-ops the user picked. */
  subOperation: SubOperationId | null;
  /** Update-mode only: the dry-run preview returned by the server. */
  updatePreview: UpdatePreview | null;
  file: File | null;
  filename: string | null;
  source: WizardSource | null;
  /** Format-helper detection result for the current upload. Set by the
   *  step-upload handler immediately after FILE_PARSED runs. Null until
   *  detection fires (or when detection found no high-confidence match). */
  detectedPreset: DetectionResult | null;
  /** True after the format-helper transform was auto-applied. Drives
   *  the banner copy (recognized vs cleaned) and gates Undo. */
  presetApplied: boolean;
  /** Snapshot of `{ rows, headers, source, mapping }` BEFORE the
   *  transform ran — used to restore on Undo. Null until a preset is
   *  applied. */
  prePresetSnapshot: {
    rows: Record<string, string>[];
    headers: string[];
    source: WizardSource | null;
    mapping: Record<string, string | null>;
  } | null;
  /** Stats from the most-recent transform — surfaced in the banner.
   *  Null when no transform has fired (or after Undo). */
  presetStats: TransformStats | null;
  market: string | null;
  /** Selected county_id (FK to counties.id). Set in lockstep with
   *  `market` via the SET_MARKET dispatch so the action can carry both
   *  to the server in one shot. */
  countyId: string | null;
  // Optional: a list name to add every imported (or matched-on-dedup)
  // property to. Empty/null = don't add to any list. On submit, the server
  // looks up a list by (org_id, name) and creates one if missing.
  listName: string | null;
  /** Surface C: opt-in flag to also request skip-trace for the newly
   *  imported properties. Default off. Only honored if total rows ≤ 500
   *  (per the per-job cost cap). */
  requestSkipTrace: boolean;
  /** Operator attestation: all contacts in this import have given written
   *  SMS consent. When true the workflow bulk-records opt_in_marketing_written
   *  for every homeowner contact after ingest. */
  smsConsent: boolean;
  /** When smsConsent=true, optionally auto-enroll every imported property
   *  into this sequence after ingest. Null = no auto-enroll. */
  sequenceId: string | null;
  /** Line-type interstitial choice (Confirm step). Unlabeled phone
   *  numbers are never saved (migration-080 hard rule) — the operator
   *  either pays to classify them via Telnyx (true) or drops them
   *  (false). Null = not chosen yet; blocks Start import while the
   *  file has unlabeled numbers. */
  classifyLineTypes: boolean | null;
  headers: string[];
  rows: Record<string, string>[];
  mapping: Record<string, string | null>;
  summary: ValidationSummary | null;
  previewRows: ValidatedRow[];
  jobId: string | null;
  submitting: boolean;
  error: string | null;
};

const initialState: WizardState = {
  step: "mode",
  mode: null,
  subOperation: null,
  updatePreview: null,
  file: null,
  filename: null,
  source: null,
  detectedPreset: null,
  presetApplied: false,
  prePresetSnapshot: null,
  presetStats: null,
  market: null,
  countyId: null,
  listName: null,
  requestSkipTrace: false,
  smsConsent: false,
  sequenceId: null,
  classifyLineTypes: null,
  headers: [],
  rows: [],
  mapping: {},
  summary: null,
  previewRows: [],
  jobId: null,
  submitting: false,
  error: null,
};

export type WizardAction =
  | { type: "SET_MODE"; mode: WizardMode }
  | { type: "SET_SUB_OPERATION"; subOperation: SubOperationId }
  | { type: "SET_UPDATE_PREVIEW"; preview: UpdatePreview }
  | {
      type: "FILE_PARSED";
      file: File;
      filename: string;
      headers: string[];
      rows: Record<string, string>[];
    }
  | {
      type: "UPDATE_FILE_PARSED";
      file: File;
      filename: string;
      headers: string[];
      rows: Record<string, string>[];
    }
  | { type: "SET_SOURCE"; source: WizardSource }
  | { type: "SET_MARKET"; market: string; countyId: string }
  | { type: "SET_LIST_NAME"; listName: string | null }
  | { type: "SET_REQUEST_SKIP_TRACE"; requestSkipTrace: boolean }
  | { type: "SET_SMS_CONSENT"; smsConsent: boolean }
  | { type: "SET_SEQUENCE_ID"; sequenceId: string | null }
  | { type: "SET_CLASSIFY_LINE_TYPES"; classifyLineTypes: boolean }
  | { type: "SET_MAPPING_FIELD"; fieldId: string; header: string | null }
  | { type: "AUTODETECT_MAPPING" }
  | {
      type: "SET_VALIDATION";
      summary: ValidationSummary;
      previewRows: ValidatedRow[];
    }
  | { type: "GOTO"; step: WizardStep }
  | { type: "SUBMIT_START" }
  | { type: "JOB_CREATED"; jobId: string }
  | { type: "SUBMIT_ERROR"; message: string }
  | {
      /** Atomic action fired by step-upload after detectVendor returns
       *  a high-confidence importable match. Snapshots the pre-state
       *  for Undo, applies the transform, sets the source, and re-runs
       *  autodetect against the new headers — all in one reducer pass
       *  so the UI never observes a partially-applied state. */
      type: "DETECT_AND_APPLY_PRESET";
      detection: DetectionResult;
      transformedRows: Record<string, string>[];
      transformedHeaders: string[];
      stats: TransformStats;
      sourceSuggestion: WizardSource | null;
    }
  | {
      /** Banner-only detection (e.g. Permits / CNAM). No transform
       *  fires; just records the detection so the banner renders. */
      type: "RECORD_NON_IMPORTABLE_DETECTION";
      detection: DetectionResult;
    }
  | { type: "UNDO_PRESET" }
  | { type: "RESET" };

function reducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case "SET_MODE":
      // Switching mode resets every downstream field so the wizard can't
      // carry a half-filled Add-mode state into Update-mode (or vice versa).
      return {
        ...initialState,
        mode: action.mode,
        step: "mode",
      };
    case "SET_SUB_OPERATION":
      // Picking a different sub-op invalidates the parsed file (its
      // required columns may have changed) and the preview.
      return {
        ...state,
        subOperation: action.subOperation,
        file: null,
        filename: null,
        headers: [],
        rows: [],
        updatePreview: null,
      };
    case "SET_UPDATE_PREVIEW":
      return { ...state, updatePreview: action.preview };
    case "FILE_PARSED": {
      const mapping = autodetectMapping(action.headers);
      return {
        ...state,
        file: action.file,
        filename: action.filename,
        headers: action.headers,
        rows: action.rows,
        mapping,
        // New file invalidates the prior interstitial choice — the new
        // file's unlabeled-phone count may differ.
        classifyLineTypes: null,
        // New file invalidates any prior format-helper detection /
        // transform — the next dispatch will be either a fresh
        // DETECT_AND_APPLY_PRESET, a RECORD_NON_IMPORTABLE_DETECTION,
        // or nothing if detection didn't fire.
        detectedPreset: null,
        presetApplied: false,
        prePresetSnapshot: null,
        presetStats: null,
      };
    }
    case "UPDATE_FILE_PARSED":
      return {
        ...state,
        file: action.file,
        filename: action.filename,
        headers: action.headers,
        rows: action.rows,
        // Re-uploading a file always re-runs the preview.
        updatePreview: null,
      };
    case "SET_SOURCE":
      return { ...state, source: action.source };
    case "SET_MARKET":
      // Per phase 02 D-04: market and county_id are set together at
      // write time. The reducer keeps them in lockstep on the client
      // so the createImportJob call can pass both — the action then
      // server-validates the countyId and uses the canonical
      // counties.market string (not state.market) when persisting.
      return { ...state, market: action.market, countyId: action.countyId };
    case "SET_LIST_NAME":
      return { ...state, listName: action.listName };
    case "SET_REQUEST_SKIP_TRACE":
      return { ...state, requestSkipTrace: action.requestSkipTrace };
    case "SET_SMS_CONSENT":
      return {
        ...state,
        smsConsent: action.smsConsent,
        // Reset sequence picker when consent is revoked
        sequenceId: action.smsConsent ? state.sequenceId : null,
      };
    case "SET_SEQUENCE_ID":
      return { ...state, sequenceId: action.sequenceId };
    case "SET_CLASSIFY_LINE_TYPES":
      return { ...state, classifyLineTypes: action.classifyLineTypes };
    case "SET_MAPPING_FIELD":
      return {
        ...state,
        mapping: { ...state.mapping, [action.fieldId]: action.header },
      };
    case "AUTODETECT_MAPPING":
      return { ...state, mapping: autodetectMapping(state.headers) };
    case "SET_VALIDATION":
      return {
        ...state,
        summary: action.summary,
        previewRows: action.previewRows,
      };
    case "GOTO":
      return { ...state, step: action.step, error: null };
    case "SUBMIT_START":
      return { ...state, submitting: true, error: null };
    case "JOB_CREATED":
      return {
        ...state,
        submitting: false,
        jobId: action.jobId,
        step: "progress",
      };
    case "SUBMIT_ERROR":
      return { ...state, submitting: false, error: action.message };
    case "DETECT_AND_APPLY_PRESET": {
      // Snapshot current state for Undo, then atomically apply
      // transform + source + re-run autodetect against the new headers.
      const snapshot = {
        rows: state.rows,
        headers: state.headers,
        source: state.source,
        mapping: state.mapping,
      };
      return {
        ...state,
        rows: action.transformedRows,
        headers: action.transformedHeaders,
        mapping: autodetectMapping(action.transformedHeaders),
        source: action.sourceSuggestion ?? state.source,
        detectedPreset: action.detection,
        presetApplied: true,
        prePresetSnapshot: snapshot,
        presetStats: action.stats,
      };
    }
    case "RECORD_NON_IMPORTABLE_DETECTION":
      // Permits / CNAM — record detection so the banner renders, but
      // don't touch rows/headers/source. No snapshot needed; nothing
      // changed.
      return {
        ...state,
        detectedPreset: action.detection,
        presetApplied: false,
        prePresetSnapshot: null,
        presetStats: null,
      };
    case "UNDO_PRESET": {
      const snap = state.prePresetSnapshot;
      if (!snap) return state;
      return {
        ...state,
        rows: snap.rows,
        headers: snap.headers,
        source: snap.source,
        mapping: snap.mapping,
        // Clear detection so banner doesn't re-fire on the same file —
        // the user explicitly chose to keep the original. They can
        // re-upload to re-trigger.
        detectedPreset: null,
        presetApplied: false,
        prePresetSnapshot: null,
        presetStats: null,
      };
    }
    case "RESET":
      return initialState;
    default:
      return state;
  }
}

export function Wizard({ counties }: { counties: CountyOption[] }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [submittingGlobal, setSubmittingGlobal] = useState(false);

  // State-machine order: includes Mode. Drives currentIndex / canGoBack.
  // Display order (`displayOrder`) below filters Mode out — see
  // indicatorOrder().
  const order = stepOrder(state.mode);
  const currentIndex = order.indexOf(state.step);
  const displayOrder = indicatorOrder(state.step, state.mode);
  // Lock back-nav once we're at progress or beyond — both flows have
  // their submit step right before progress, so freeze after submit.
  const lockBackFromIndex = state.mode === "update" ? 4 : 5;
  const canGoBack = currentIndex > 0 && currentIndex < lockBackFromIndex;

  // Derive per-step readiness for the Next button.
  const sections = useMemo(() => mappedSections(state.mapping), [state.mapping]);

  // Distinct phone numbers that would ingest with no line type — the
  // set the hard rule drops unless the operator pays to classify them.
  // Only computed on Confirm (full-file validation pass, same cost as
  // the Review step's breakdown).
  const unlabeledPhoneCount = useMemo(() => {
    if (state.step !== "confirm") return 0;
    return collectUnlabeledPhones(state.rows, state.mapping).length;
  }, [state.step, state.rows, state.mapping]);

  const uploadReady =
    !!state.file &&
    !!state.source &&
    !!state.market &&
    !!state.countyId &&
    state.rows.length > 0;
  const hasAddressFull = !!state.mapping.address_full;
  const mapReady =
    sections.property &&
    (!!state.mapping.address || hasAddressFull) &&
    (!!state.mapping.state || hasAddressFull);
  const reviewReady =
    !!state.summary && state.summary.validRows > 0 && uploadReady && mapReady;

  const updateUploadReady =
    !!state.file && !!state.subOperation && state.rows.length > 0;
  const previewReady =
    !!state.updatePreview && state.updatePreview.matched.length > 0;

  const handleNext = async () => {
    // ---- Mode router (both flows) -----------------------------------------
    if (state.step === "mode") {
      if (state.mode === "add") dispatch({ type: "GOTO", step: "upload" });
      else if (state.mode === "update")
        dispatch({ type: "GOTO", step: "suboperation" });
      return;
    }

    // ---- Update flow ------------------------------------------------------
    if (state.step === "suboperation") {
      dispatch({ type: "GOTO", step: "update-upload" });
      return;
    }
    if (state.step === "update-upload") {
      dispatch({ type: "GOTO", step: "preview-update" });
      return;
    }
    if (state.step === "preview-update") {
      setSubmittingGlobal(true);
      dispatch({ type: "SUBMIT_START" });
      const result = await callAction(
        runBulkUpdateJob({
          subOperationId: state.subOperation!,
          rows: state.rows,
          filename: state.filename ?? "update.csv",
        }),
        {
          successMessage: "Update started.",
          fallbackMessage: "Update failed to start",
        },
      );
      if (!result.ok) {
        dispatch({ type: "SUBMIT_ERROR", message: result.error.message });
        setSubmittingGlobal(false);
        return;
      }
      dispatch({ type: "JOB_CREATED", jobId: result.data.jobId });
      setSubmittingGlobal(false);
      return;
    }

    // ---- Add flow (existing) ---------------------------------------------
    if (state.step === "upload") {
      dispatch({ type: "GOTO", step: "map" });
      return;
    }
    if (state.step === "map") {
      const previewRows = state.rows
        .slice(0, 10)
        .map((row, idx) => validateRow(row, state.mapping, idx));
      const allValidated = state.rows.map((row, idx) =>
        validateRow(row, state.mapping, idx),
      );
      const summary = summarize(allValidated);
      dispatch({ type: "SET_VALIDATION", summary, previewRows });
      dispatch({ type: "GOTO", step: "review" });
      return;
    }
    if (state.step === "review") {
      dispatch({ type: "GOTO", step: "confirm" });
      return;
    }
    if (state.step === "confirm") {
      setSubmittingGlobal(true);
      dispatch({ type: "SUBMIT_START" });
      // Upload the original file to Supabase Storage so the workflow
      // runner can download + parse it server-side. We send the storage
      // path (and not the rows) to the action — bypasses the Server
      // Action body-size limit entirely. trimRowsToMapping is no longer
      // needed; the workflow does its own trim after download.
      const uploadResult = await uploadCsvToStorage(state.file!);
      if (!uploadResult.ok) {
        dispatch({ type: "SUBMIT_ERROR", message: uploadResult.error });
        setSubmittingGlobal(false);
        return;
      }
      const result = await callAction(
        createImportJob({
          filename: state.filename!,
          source: state.source!,
          market: state.market!,
          // Per phase 02 D-04: county_id is set in lockstep with market.
          // The action server-validates this id against the counties
          // table and uses the row's canonical `market` value (not the
          // string we send) when persisting. Sending state.market is
          // still useful for the action's error path / log breadcrumb.
          countyId: state.countyId!,
          listName: state.listName?.trim() || null,
          mapping: state.mapping,
          storagePath: uploadResult.storagePath,
          totalRows: state.rows.length,
          smsConsent: state.smsConsent,
          sequenceId: state.sequenceId,
          // Interstitial choice. No unlabeled numbers → nothing to
          // classify, so an unmade choice (null) submits as false.
          classifyLineTypes: state.classifyLineTypes === true,
          preset:
            state.presetApplied && state.detectedPreset && state.presetStats
              ? {
                  id: state.detectedPreset.id,
                  // Preset version travels via getPresetById on the
                  // server side if needed — for now we record the id
                  // + the wizard-side stats. The detection's id is
                  // stable; version is recorded as 1 in v1 of every
                  // preset module.
                  version: 1,
                  stats: state.presetStats,
                }
              : null,
        }),
        { successMessage: "Import started.", fallbackMessage: "Import failed to start" },
      );
      if (!result.ok) {
        dispatch({ type: "SUBMIT_ERROR", message: result.error.message });
        setSubmittingGlobal(false);
        return;
      }
      dispatch({ type: "JOB_CREATED", jobId: result.data.jobId });
      setSubmittingGlobal(false);
      return;
    }

    // ---- Common tail -----------------------------------------------------
    // Progress is the terminal step; the StepProgress card itself
    // surfaces the "View properties / Job details / New import"
    // actions inline once the job reaches a terminal status. The
    // wizard's footer Next button is hidden on this step.
  };

  const handleBack = () => {
    const prev = order[currentIndex - 1];
    if (prev) dispatch({ type: "GOTO", step: prev });
  };

  const nextDisabled =
    state.submitting ||
    submittingGlobal ||
    (state.step === "mode" && !state.mode) ||
    (state.step === "suboperation" && !state.subOperation) ||
    (state.step === "update-upload" && !updateUploadReady) ||
    (state.step === "preview-update" && !previewReady) ||
    (state.step === "upload" && !uploadReady) ||
    (state.step === "map" && !mapReady) ||
    (state.step === "review" && !reviewReady) ||
    // The interstitial is a forced choice: with unlabeled phone numbers
    // in the file, Start import stays locked until the operator picks
    // Classify or Skip.
    (state.step === "confirm" &&
      unlabeledPhoneCount > 0 &&
      state.classifyLineTypes === null);

  const nextLabel = (() => {
    if (state.step === "preview-update") {
      return state.submitting ? "Starting…" : "Confirm & apply";
    }
    if (state.step === "confirm") {
      return state.submitting ? "Starting…" : "Start import";
    }
    return "Next";
  })();

  // Hide the wizard's Back/Next buttons entirely on the progress
  // step — the card itself shows terminal-state action buttons, and
  // a "Next"/"Back" footer would contradict the "you can close this
  // tab" copy that's visible while the job is running.
  const showFooterNav = state.step !== "progress";

  return (
    <div className="flex flex-col gap-6">
      {displayOrder.length > 0 && (
        <StepIndicator step={state.step} order={displayOrder} />
      )}

      <div className="flex flex-1 flex-col">
        {state.step === "mode" && (
          <StepMode state={state} dispatch={dispatch} />
        )}
        {state.step === "suboperation" && (
          <StepSubOperation state={state} dispatch={dispatch} />
        )}
        {state.step === "update-upload" && (
          <StepUpdateUpload state={state} dispatch={dispatch} />
        )}
        {state.step === "preview-update" && (
          <StepPreviewUpdate state={state} dispatch={dispatch} />
        )}
        {state.step === "upload" && (
          <StepUpload state={state} dispatch={dispatch} counties={counties} />
        )}
        {state.step === "map" && <StepMap state={state} dispatch={dispatch} />}
        {state.step === "review" && (
          <StepReview state={state} dispatch={dispatch} />
        )}
        {state.step === "confirm" && (
          <StepConfirm
            state={state}
            dispatch={dispatch}
            unlabeledPhoneCount={unlabeledPhoneCount}
          />
        )}
        {state.step === "progress" && state.jobId && (
          <StepProgress jobId={state.jobId} />
        )}
      </div>

      {state.error && (
        <div className="text-destructive text-sm">{state.error}</div>
      )}

      {showFooterNav && (
        <div className="flex items-center justify-between">
          <Button
            variant="ghost"
            onClick={handleBack}
            disabled={!canGoBack || state.submitting}
            className="-ml-8"
          >
            Back
          </Button>
          <Button onClick={handleNext} disabled={nextDisabled}>
            {nextLabel}
          </Button>
        </div>
      )}
    </div>
  );
}

function StepIndicator({
  step,
  order,
}: {
  step: WizardStep;
  order: readonly WizardStep[];
}) {
  const currentIndex = order.indexOf(step);
  return (
    <ol className="flex items-center gap-2 text-sm">
      {order.map((s, i) => {
        const isActive = i === currentIndex;
        const isPast = i < currentIndex;
        // Cascade-in steps 2+ each time the indicator mounts. Step 1
        // (whatever follows Mode) is the static anchor, the rest fade
        // in left-to-right. Indicator unmounts when the user goes back
        // to Mode, so the cascade re-plays on every forward transition.
        const cascade = i > 0;
        return (
          <li
            key={s}
            className={cn(
              "flex items-center gap-2",
              cascade &&
                "animate-in fade-in-0 slide-in-from-left-3 duration-300",
            )}
            style={
              cascade
                ? {
                    animationDelay: `${i * 80}ms`,
                    animationFillMode: "both",
                  }
                : undefined
            }
          >
            <span
              className={`flex size-6 items-center justify-center rounded-full border text-xs ${
                isActive
                  ? "border-primary bg-primary text-primary-foreground"
                  : isPast
                    ? "border-primary text-primary"
                    : "border-border text-muted-foreground"
              }`}
            >
              {i + 1}
            </span>
            <span
              className={
                isActive
                  ? "font-medium"
                  : isPast
                    ? "text-foreground"
                    : "text-muted-foreground"
              }
            >
              {STEP_LABELS[s]}
            </span>
            {i < order.length - 1 && (
              <span className="text-muted-foreground">›</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
