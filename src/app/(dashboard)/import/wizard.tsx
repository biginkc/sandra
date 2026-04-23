"use client";

import { useMemo, useReducer, useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { autodetectMapping } from "@/lib/csv/aliases";
import {
  mappedSections,
  summarize,
  validateRow,
  type ValidatedRow,
  type ValidationSummary,
} from "@/lib/csv/validate";
import { callAction } from "@/lib/errors/call-action";

import { createImportJob } from "./actions";
import { StepUpload } from "./steps/step-upload";
import { StepMap } from "./steps/step-map";
import { StepReview } from "./steps/step-review";
import { StepConfirm } from "./steps/step-confirm";
import { StepProgress } from "./steps/step-progress";
import { StepDone } from "./steps/step-done";

export type WizardStep =
  | "upload"
  | "map"
  | "review"
  | "confirm"
  | "progress"
  | "done";

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

const STEP_ORDER: readonly WizardStep[] = [
  "upload",
  "map",
  "review",
  "confirm",
  "progress",
  "done",
];

const STEP_LABELS: Record<WizardStep, string> = {
  upload: "Upload",
  map: "Map",
  review: "Review",
  confirm: "Confirm",
  progress: "Progress",
  done: "Done",
};

export type WizardState = {
  step: WizardStep;
  file: File | null;
  filename: string | null;
  source: WizardSource | null;
  market: WizardMarket | null;
  // Optional: a list name to add every imported (or matched-on-dedup)
  // property to. Empty/null = don't add to any list. On submit, the server
  // looks up a list by (org_id, name) and creates one if missing.
  listName: string | null;
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
  step: "upload",
  file: null,
  filename: null,
  source: null,
  market: null,
  listName: null,
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
  | {
      type: "FILE_PARSED";
      file: File;
      filename: string;
      headers: string[];
      rows: Record<string, string>[];
    }
  | { type: "SET_SOURCE"; source: WizardSource }
  | { type: "SET_MARKET"; market: WizardMarket }
  | { type: "SET_LIST_NAME"; listName: string | null }
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
    case "SET_SOURCE":
      return { ...state, source: action.source };
    case "SET_MARKET":
      return { ...state, market: action.market };
    case "SET_LIST_NAME":
      return { ...state, listName: action.listName };
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

  const currentIndex = STEP_ORDER.indexOf(state.step);
  const canGoBack = currentIndex > 0 && currentIndex < 4; // lock after submit

  // Derive per-step readiness for the Next button.
  const sections = useMemo(() => mappedSections(state.mapping), [state.mapping]);

  const uploadReady =
    !!state.file && !!state.source && !!state.market && state.rows.length > 0;
  // Address + State are required. A mapped `address_full` column counts as
  // a substitute for both — the validator parses it into components at
  // row-validation time.
  const hasAddressFull = !!state.mapping.address_full;
  const mapReady =
    sections.property &&
    (!!state.mapping.address || hasAddressFull) &&
    (!!state.mapping.state || hasAddressFull);
  const reviewReady =
    !!state.summary && state.summary.validRows > 0 && uploadReady && mapReady;

  const handleNext = async () => {
    if (state.step === "upload") {
      dispatch({ type: "GOTO", step: "map" });
      return;
    }
    if (state.step === "map") {
      // Run validation on the first 10 rows for the review pane,
      // and on ALL rows to compute the summary counts.
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
    const prev = STEP_ORDER[currentIndex - 1];
    if (prev) dispatch({ type: "GOTO", step: prev });
  };

  const nextDisabled =
    state.submitting ||
    submittingGlobal ||
    (state.step === "upload" && !uploadReady) ||
    (state.step === "map" && !mapReady) ||
    (state.step === "review" && !reviewReady);

  const nextLabel =
    state.step === "confirm"
      ? state.submitting
        ? "Starting…"
        : "Start import"
      : state.step === "done"
        ? "View properties"
        : "Next";

  return (
    <div className="flex flex-col gap-6 p-6">
      <StepIndicator step={state.step} />

      <div className="flex flex-1 flex-col">
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

function StepIndicator({ step }: { step: WizardStep }) {
  const currentIndex = STEP_ORDER.indexOf(step);
  return (
    <ol className="flex items-center gap-2 text-sm">
      {STEP_ORDER.map((s, i) => {
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
            {i < STEP_ORDER.length - 1 && (
              <span className="text-muted-foreground">›</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
