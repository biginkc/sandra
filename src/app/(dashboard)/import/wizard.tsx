"use client";

import { useMemo, useReducer, useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { autodetectMapping } from "@/lib/csv/aliases";
import type { UpdatePreview } from "@/lib/csv/update-bulk";
import type { SubOperationId } from "@/lib/csv/update-operations";
import {
  mappedSections,
  summarize,
  validateRow,
  type ValidatedRow,
  type ValidationSummary,
} from "@/lib/csv/validate";
import { callAction } from "@/lib/errors/call-action";

import { createImportJob, runBulkUpdateJob } from "./actions";
import { StepConfirm } from "./steps/step-confirm";
import { StepDone } from "./steps/step-done";
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
  // Both flows end here.
  | "progress"
  | "done";

export type WizardMode = "add" | "update";

export type WizardSource =
  | "dealmachine"
  | "zillow"
  | "realtor"
  | "mls"
  | "generic";

export type WizardMarket =
  | "Kansas City"
  | "St. Louis"
  | "Dayton"
  | "Lake of the Ozarks";

const ADD_STEP_ORDER: readonly WizardStep[] = [
  "mode",
  "upload",
  "map",
  "review",
  "confirm",
  "progress",
  "done",
];

const UPDATE_STEP_ORDER: readonly WizardStep[] = [
  "mode",
  "suboperation",
  "update-upload",
  "preview-update",
  "progress",
  "done",
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
  done: "Done",
};

function stepOrder(mode: WizardMode | null): readonly WizardStep[] {
  if (mode === "update") return UPDATE_STEP_ORDER;
  if (mode === "add") return ADD_STEP_ORDER;
  return ["mode"]; // before mode is picked, the indicator is just the one step
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
  market: WizardMarket | null;
  // Optional: a list name to add every imported (or matched-on-dedup)
  // property to. Empty/null = don't add to any list. On submit, the server
  // looks up a list by (org_id, name) and creates one if missing.
  listName: string | null;
  /** Surface C: opt-in flag to also request skip-trace for the newly
   *  imported properties. Default off. Only honored if total rows ≤ 500
   *  (per the per-job cost cap). */
  requestSkipTrace: boolean;
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
  market: null,
  listName: null,
  requestSkipTrace: false,
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
  | { type: "SET_MARKET"; market: WizardMarket }
  | { type: "SET_LIST_NAME"; listName: string | null }
  | { type: "SET_REQUEST_SKIP_TRACE"; requestSkipTrace: boolean }
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
      return { ...state, market: action.market };
    case "SET_LIST_NAME":
      return { ...state, listName: action.listName };
    case "SET_REQUEST_SKIP_TRACE":
      return { ...state, requestSkipTrace: action.requestSkipTrace };
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
    case "RESET":
      return initialState;
    default:
      return state;
  }
}

export function Wizard() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const router = useRouter();
  const [submittingGlobal, setSubmittingGlobal] = useState(false);

  const order = stepOrder(state.mode);
  const currentIndex = order.indexOf(state.step);
  // Lock back-nav once we're at progress or beyond — both flows have
  // their submit step right before progress, so freeze after submit.
  const lockBackFromIndex = state.mode === "update" ? 4 : 5;
  const canGoBack = currentIndex > 0 && currentIndex < lockBackFromIndex;

  // Derive per-step readiness for the Next button.
  const sections = useMemo(() => mappedSections(state.mapping), [state.mapping]);

  const uploadReady =
    !!state.file && !!state.source && !!state.market && state.rows.length > 0;
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
      const result = await callAction(
        createImportJob({
          filename: state.filename!,
          source: state.source!,
          market: state.market!,
          listName: state.listName?.trim() || null,
          mapping: state.mapping,
          rows: state.rows,
          requestSkipTrace: state.requestSkipTrace,
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
    if (state.step === "progress") {
      dispatch({ type: "GOTO", step: "done" });
      return;
    }
    if (state.step === "done") {
      dispatch({ type: "RESET" });
      router.push("/properties");
    }
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
    (state.step === "review" && !reviewReady);

  const nextLabel = (() => {
    if (state.step === "preview-update") {
      return state.submitting ? "Starting…" : "Confirm & apply";
    }
    if (state.step === "confirm") {
      return state.submitting ? "Starting…" : "Start import";
    }
    if (state.step === "done") return "View properties";
    return "Next";
  })();

  return (
    <div className="flex flex-col gap-6 p-6">
      <StepIndicator step={state.step} order={order} />

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
          <StepUpload state={state} dispatch={dispatch} />
        )}
        {state.step === "map" && <StepMap state={state} dispatch={dispatch} />}
        {state.step === "review" && (
          <StepReview state={state} dispatch={dispatch} />
        )}
        {state.step === "confirm" && (
          <StepConfirm state={state} dispatch={dispatch} />
        )}
        {state.step === "progress" && state.jobId && (
          <StepProgress jobId={state.jobId} />
        )}
        {state.step === "done" && state.jobId && (
          <StepDone jobId={state.jobId} />
        )}
      </div>

      {state.error && (
        <div className="text-destructive text-sm">{state.error}</div>
      )}

      <div className="flex items-center justify-between">
        <Button
          variant="ghost"
          onClick={handleBack}
          disabled={!canGoBack || state.submitting}
        >
          Back
        </Button>
        <Button onClick={handleNext} disabled={nextDisabled}>
          {nextLabel}
        </Button>
      </div>
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
        return (
          <li key={s} className="flex items-center gap-2">
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
