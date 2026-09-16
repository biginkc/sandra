"use client";

import {
  AlertTriangle,
  BookOpen,
  Check,
  ChevronRight,
  CircleHelp,
  Home,
  Info,
  Link2,
  Lock,
  LockKeyholeOpen,
  RotateCcw,
  Save,
  Search,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/page-header";
import {
  calculateClosr,
  DEFAULT_DECISION,
  DEFAULT_INPUTS,
  EXPENSE_FIELDS,
  formatListingPercentage,
  formatDollars,
  REHAB_REFERENCE,
} from "@/lib/calculators/closr-v1";
import type {
  CalculatorActionResult,
  CalculatorDecision,
  CalculatorInputs,
  CalculatorLead,
  CalculatorProvenance,
  CalculatorResults,
  CalculatorSnapshot,
  SaveCalculationInput,
} from "@/lib/calculators/types";

import styles from "./calculator.module.css";

type SearchLeads = (
  query: string,
) => Promise<CalculatorActionResult<CalculatorLead[]>>;
type SaveCalculation = (
  input: SaveCalculationInput,
) => Promise<CalculatorActionResult<CalculatorSnapshot>>;

export type CalculatorClientProps = {
  initialLead: CalculatorLead | null;
  initialSnapshot: CalculatorSnapshot | null;
  initialProvenance?: CalculatorProvenance | null;
  leadOptions?: CalculatorLead[];
  searchLeads?: SearchLeads;
  saveCalculation?: SaveCalculation;
};

const EXPENSE_FIELD_LABELS = new Map<string, string>(EXPENSE_FIELDS);
const PROGRAMS: Array<{
  value: CalculatorDecision["program"];
  label: string;
  range: string;
  result: keyof Pick<CalculatorResults, "equity" | "family" | "secure" | "rapid">;
}> = [
  { value: "equity_protection", label: "Equity Protection", range: "9+", result: "equity" },
  { value: "family_placement", label: "Family Placement", range: "6 – 8", result: "family" },
  { value: "secure_close", label: "Secure Close", range: "3 – 5", result: "secure" },
  { value: "rapid_relief", label: "Rapid Relief", range: "1 – 2", result: "rapid" },
];
const FEE_TIERS: CalculatorDecision["feeTier"][] = [40000, 30000, 20000, 10000];

const copyInputs = (inputs: CalculatorInputs): CalculatorInputs => ({ ...inputs });
const copyDecision = (decision: CalculatorDecision): CalculatorDecision => ({ ...decision });

type InputKey = keyof CalculatorInputs;
type DraftParse = {
  kind: "empty" | "incomplete" | "valid" | "invalid";
  value: number | null;
};

function draftsFromInputs(inputs: CalculatorInputs): Record<InputKey, string> {
  return Object.fromEntries(
    Object.keys(inputs).map((key) => [key, inputValue(inputs[key as InputKey])]),
  ) as Record<InputKey, string>;
}

function parseDraft(value: string): DraftParse {
  const normalized = value.replace(/[$,\s]/g, "");
  if (normalized === "") return { kind: "empty", value: null };
  if (normalized === "-" || normalized === "." || normalized === "-.") {
    return { kind: "incomplete", value: null };
  }
  if (!/^-?(?:(?:\d+\.?\d*)|(?:\.\d+))$/.test(normalized)) {
    return { kind: "invalid", value: null };
  }
  const number = Number(normalized);
  return Number.isFinite(number)
    ? { kind: "valid", value: number }
    : { kind: "invalid", value: null };
}

function listingPercentageFactor(value: string): number | null {
  const normalized = value.replace(/[$,\s]/g, "");
  const parsed = parseDraft(value);
  if (parsed.kind === "empty") return null;
  if (parsed.kind !== "valid") return null;
  const factor = Number(`${normalized}e-2`);
  return Number.isFinite(factor) ? factor : null;
}

function inputValue(value: number | null): string {
  return value == null ? "" : String(value);
}

function inputWithinBounds(key: InputKey, value: number | null): boolean {
  if (value == null) return true;
  if (key === "listingPercentage") return value >= 0 && value <= 1;
  return value >= 0 && value <= 1e12;
}

function listingPercentageDraftWithinBounds(value: number | null): boolean {
  return value == null || (value >= 0 && value <= 100);
}

function proposedOfferWithinBounds(value: number | null): boolean {
  return value == null || Math.abs(value) <= 1e12;
}

function boundsMessage(key: InputKey): string {
  if (key === "listingPercentage") return "Listing percentage must be between 0% and 100%.";
  return "Use a nonnegative amount up to $1,000,000,000,000.";
}

function sameInputs(left: CalculatorInputs, right: CalculatorInputs): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function leadProvenanceLabel(provenance: CalculatorProvenance | null): string {
  if (!provenance) return "";
  if (provenance.source === "lead_calculations") {
    return "Attached automatically — opened from this lead’s Calculations tab";
  }
  if (provenance.source === "saved_calculation") {
    return "Attached from a saved calculation";
  }
  return "Attached from Calculators · selected just now";
}

function resultAmount(value: number): string {
  return formatDollars(value);
}

function newRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  throw new Error("Secure request IDs are unavailable in this browser.");
}

export default function CalculatorClient({
  initialLead,
  initialSnapshot,
  initialProvenance,
  leadOptions = [],
  searchLeads,
  saveCalculation,
}: CalculatorClientProps) {
  const [lead, setLead] = useState<CalculatorLead | null>(initialLead);
  const [provenance, setProvenance] = useState<CalculatorProvenance | null>(
      initialProvenance ??
      initialSnapshot?.provenance ??
      (initialLead ? { source: "lead_calculations", leadId: initialLead.id } : null),
  );
  const [inputs, setInputs] = useState<CalculatorInputs>(() =>
    copyInputs(initialSnapshot?.inputs ?? DEFAULT_INPUTS),
  );
  const [draftInputs, setDraftInputs] = useState<Record<InputKey, string>>(() =>
    draftsFromInputs(initialSnapshot?.inputs ?? DEFAULT_INPUTS),
  );
  const [decision, setDecision] = useState<CalculatorDecision>(() =>
    copyDecision(initialSnapshot?.decision ?? DEFAULT_DECISION),
  );
  const [draftListingPercentage, setDraftListingPercentage] = useState(() =>
    formatListingPercentage(initialSnapshot ? initialSnapshot.inputs.listingPercentage : DEFAULT_INPUTS.listingPercentage),
  );
  const [draftProposedOffer, setDraftProposedOffer] = useState(() =>
    inputValue(initialSnapshot?.decision.proposedOffer ?? DEFAULT_DECISION.proposedOffer),
  );
  const [draftErrors, setDraftErrors] = useState<Record<string, string>>({});
  const [baselineInputs, setBaselineInputs] = useState<CalculatorInputs>(() =>
    copyInputs(initialSnapshot?.inputs ?? DEFAULT_INPUTS),
  );
  const [savedSnapshot, setSavedSnapshot] = useState<CalculatorSnapshot | null>(
    initialSnapshot,
  );
  const [guideOpen, setGuideOpen] = useState(false);
  const [leadPickerOpen, setLeadPickerOpen] = useState(false);
  const [leadSearch, setLeadSearch] = useState("");
  const [remoteLeads, setRemoteLeads] = useState<CalculatorLead[] | null>(null);
  const [leadSearchPending, setLeadSearchPending] = useState(false);
  const [leadSearchError, setLeadSearchError] = useState<string | null>(null);
  const [listingLocked, setListingLocked] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const [requestRevision, setRequestRevision] = useState(0);
  const saveRequest = useRef<{ fingerprint: string; requestId: string } | null>(null);
  const saveInFlight = useRef(false);
  const searchGeneration = useRef(0);
  const formRevision = useRef(0);
  const guideDrawerRef = useRef<HTMLElement | null>(null);
  const guideCloseRef = useRef<HTMLButtonElement | null>(null);

  const formFingerprint = JSON.stringify({
    leadId: lead?.id ?? null,
    inputs,
    decision,
    parentId: savedSnapshot && savedSnapshot.property_id === lead?.id ? savedSnapshot.id : null,
    provenance,
  });

  const inputsChanged = !sameInputs(inputs, baselineInputs);
  const results = useMemo<CalculatorResults>(() => {
    if (savedSnapshot && !inputsChanged) return savedSnapshot.results;
    return calculateClosr(inputs);
  }, [inputs, inputsChanged, savedSnapshot]);

  useEffect(() => {
    if (!leadPickerOpen || !searchLeads) return;
    const generation = ++searchGeneration.current;
    const query = leadSearch.trim();
    const timeout = window.setTimeout(() => {
      setLeadSearchPending(true);
      setLeadSearchError(null);
      void searchLeads(query)
        .then((result) => {
          if (generation !== searchGeneration.current) return;
          if (result.ok) setRemoteLeads(result.data);
          else setLeadSearchError(result.error);
        })
        .catch(() => {
          if (generation === searchGeneration.current) setLeadSearchError("Could not search leads. Try again.");
        })
        .finally(() => {
          if (generation === searchGeneration.current) setLeadSearchPending(false);
        });
    }, 180);
    return () => {
      window.clearTimeout(timeout);
      searchGeneration.current += 1;
    };
  }, [leadPickerOpen, leadSearch, searchLeads]);

  useEffect(() => {
    if (!guideOpen) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const drawer = guideDrawerRef.current;
    guideCloseRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setGuideOpen(false);
        return;
      }
      if (event.key !== "Tab" || !drawer) return;
      const focusable = Array.from(
        drawer.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, [guideOpen]);

  const visibleLeads = useMemo(() => {
    const source = remoteLeads ?? leadOptions;
    const query = leadSearch.trim().toLowerCase();
    if (!query || remoteLeads) return source;
    return source.filter(
      (candidate) =>
        candidate.address.toLowerCase().includes(query) ||
        candidate.seller.toLowerCase().includes(query),
    );
  }, [leadOptions, leadSearch, remoteLeads]);

  const updateInput = (key: keyof CalculatorInputs, value: string) => {
    if (saving || saveInFlight.current) return;
    formRevision.current += 1;
  const parsed = parseDraft(value);
    setDraftInputs((previous) => ({ ...previous, [key]: value }));
    if ((parsed.kind === "valid" || parsed.kind === "empty") && inputWithinBounds(key, parsed.value)) {
      setInputs((previous) => ({ ...previous, [key]: parsed.value }));
      setDraftErrors((previous) => {
        if (!previous[key]) return previous;
        const next = { ...previous };
        delete next[key];
        return next;
      });
    }
    setSaveError(null);
    setSaveSuccess(null);
  };

  const updateListingPercentage = (value: string) => {
    if (saving || saveInFlight.current) return;
    formRevision.current += 1;
    const parsed = parseDraft(value);
    setDraftListingPercentage(value);
    if ((parsed.kind === "valid" || parsed.kind === "empty") && listingPercentageDraftWithinBounds(parsed.value)) {
      setInputs((previous) => ({
        ...previous,
        listingPercentage: listingPercentageFactor(value),
      }));
      setDraftErrors((previous) => {
        if (!previous.listingPercentage) return previous;
        const next = { ...previous };
        delete next.listingPercentage;
        return next;
      });
    }
    setSaveError(null);
    setSaveSuccess(null);
  };

  const validateDrafts = (): boolean => {
    const nextInputs = copyInputs(inputs);
    const nextDraftInputs = { ...draftInputs };
    const nextErrors: Record<string, string> = {};
    let valid = true;
    for (const key of Object.keys(draftInputs) as InputKey[]) {
      const parsed = parseDraft(draftInputs[key]);
      if ((parsed.kind === "valid" || parsed.kind === "empty") && inputWithinBounds(key, parsed.value)) {
        nextInputs[key] = parsed.value;
      } else {
        valid = false;
        nextErrors[key] = parsed.kind === "valid" || parsed.kind === "empty"
          ? boundsMessage(key)
          : "Enter a number or leave this field blank.";
      }
    }
    const listingDraftMatchesStoredValue = draftListingPercentage === formatListingPercentage(inputs.listingPercentage);
    const percentage = parseDraft(draftListingPercentage);
    if (listingDraftMatchesStoredValue) {
      nextInputs.listingPercentage = inputs.listingPercentage;
    } else if ((percentage.kind === "valid" || percentage.kind === "empty") && listingPercentageDraftWithinBounds(percentage.value)) {
      nextInputs.listingPercentage = listingPercentageFactor(draftListingPercentage);
    } else {
      valid = false;
      nextErrors.listingPercentage = percentage.kind === "valid" || percentage.kind === "empty"
        ? boundsMessage("listingPercentage")
        : "Enter a percentage or leave this field blank.";
    }
    const proposedOffer = parseDraft(draftProposedOffer);
    if ((proposedOffer.kind === "valid" || proposedOffer.kind === "empty") && proposedOfferWithinBounds(proposedOffer.value)) {
      setDecision((previous) => ({ ...previous, proposedOffer: proposedOffer.value }));
    } else {
      valid = false;
      nextErrors.proposedOffer = proposedOffer.kind === "valid" || proposedOffer.kind === "empty"
        ? "Proposed offer must be within ±$1,000,000,000,000."
        : "Enter an offer amount or leave this field blank.";
    }
    setInputs(nextInputs);
    setDraftInputs(nextDraftInputs);
    setDraftErrors(nextErrors);
    return valid;
  };

  const validateInputDraft = (key: InputKey) => {
    const parsed = parseDraft(draftInputs[key]);
    if ((parsed.kind === "valid" || parsed.kind === "empty") && inputWithinBounds(key, parsed.value)) {
      setInputs((previous) => ({ ...previous, [key]: parsed.value }));
      setDraftErrors((previous) => {
        if (!previous[key]) return previous;
        const next = { ...previous };
        delete next[key];
        return next;
      });
      return;
    }
    setDraftErrors((previous) => ({
      ...previous,
      [key]: parsed.kind === "valid" || parsed.kind === "empty"
        ? boundsMessage(key)
        : "Enter a number or leave this field blank.",
    }));
  };

  const validateListingDraft = () => {
    if (draftListingPercentage === formatListingPercentage(inputs.listingPercentage)) {
      setDraftErrors((previous) => {
        if (!previous.listingPercentage) return previous;
        const next = { ...previous };
        delete next.listingPercentage;
        return next;
      });
      return;
    }
    const parsed = parseDraft(draftListingPercentage);
    if ((parsed.kind === "valid" || parsed.kind === "empty") && listingPercentageDraftWithinBounds(parsed.value)) {
      setInputs((previous) => ({
        ...previous,
        listingPercentage: listingPercentageFactor(draftListingPercentage),
      }));
      setDraftErrors((previous) => {
        if (!previous.listingPercentage) return previous;
        const next = { ...previous };
        delete next.listingPercentage;
        return next;
      });
      return;
    }
    setDraftErrors((previous) => ({
      ...previous,
      listingPercentage: parsed.kind === "valid" || parsed.kind === "empty"
        ? boundsMessage("listingPercentage")
        : "Enter a percentage or leave this field blank.",
    }));
  };

  const updateProposedOffer = (value: string) => {
    if (saving || saveInFlight.current) return;
    formRevision.current += 1;
    const parsed = parseDraft(value);
    setDraftProposedOffer(value);
    if ((parsed.kind === "valid" || parsed.kind === "empty") && proposedOfferWithinBounds(parsed.value)) {
      setDecision((previous) => ({ ...previous, proposedOffer: parsed.value }));
      setDraftErrors((previous) => {
        if (!previous.proposedOffer) return previous;
        const next = { ...previous };
        delete next.proposedOffer;
        return next;
      });
    }
    setSaveError(null);
    setSaveSuccess(null);
  };

  const validateProposedOfferDraft = () => {
    const parsed = parseDraft(draftProposedOffer);
    if ((parsed.kind === "valid" || parsed.kind === "empty") && proposedOfferWithinBounds(parsed.value)) {
      setDecision((previous) => ({ ...previous, proposedOffer: parsed.value }));
      setDraftErrors((previous) => {
        if (!previous.proposedOffer) return previous;
        const next = { ...previous };
        delete next.proposedOffer;
        return next;
      });
      return;
    }
    setDraftErrors((previous) => ({
      ...previous,
      proposedOffer: parsed.kind === "valid" || parsed.kind === "empty"
        ? "Proposed offer must be within ±$1,000,000,000,000."
        : "Enter an offer amount or leave this field blank.",
    }));
  };

  const reset = () => {
    if (saving || saveInFlight.current) return;
    formRevision.current += 1;
    const nextInputs = copyInputs(savedSnapshot?.inputs ?? DEFAULT_INPUTS);
    const nextDecision = copyDecision(savedSnapshot?.decision ?? DEFAULT_DECISION);
    setInputs(nextInputs);
    setDraftInputs(draftsFromInputs(nextInputs));
    setDraftListingPercentage(formatListingPercentage(nextInputs.listingPercentage));
    setBaselineInputs(nextInputs);
    setDecision(nextDecision);
    setDraftProposedOffer(inputValue(nextDecision.proposedOffer));
    setDraftErrors({});
    setSaveError(null);
    setSaveSuccess(null);
  };

  const selectLead = (selected: CalculatorLead) => {
    if (saving || saveInFlight.current) return;
    formRevision.current += 1;
    setLead(selected);
    setProvenance({ source: "lead_search", leadId: selected.id });
    setLeadPickerOpen(false);
    setLeadSearch("");
    setRemoteLeads(null);
    setLeadSearchError(null);
    setSaveError(null);
  };

  const detachLead = () => {
    if (saving || saveInFlight.current) return;
    formRevision.current += 1;
    setLead(null);
    setProvenance(null);
    setLeadPickerOpen(false);
    setSaveError(null);
  };

  const handleSave = async () => {
    if (saveInFlight.current) return;
    if (!lead) {
      setSaveError("Attach a lead before saving this calculation.");
      return;
    }
    if (!saveCalculation) {
      setSaveError("Saving is not available right now.");
      return;
    }
    const hadDraftErrors = Object.keys(draftErrors).length > 0;
    if (!validateDrafts() || hadDraftErrors) {
      setSaveError("Fix the highlighted fields before saving this calculation.");
      return;
    }
    const nextProvenance = provenance ?? { source: "lead_search", leadId: lead.id };
    const parentId = savedSnapshot?.property_id === lead.id ? savedSnapshot.id : null;
    const fingerprint = formFingerprint;
    const revisionAtStart = formRevision.current;
    let requestId = saveRequest.current?.requestId;
    if (!requestId || saveRequest.current?.fingerprint !== fingerprint) {
      try {
        requestId = newRequestId();
      } catch {
        setSaveError("Secure request IDs are unavailable in this browser. Reload and try again.");
        return;
      }
      saveRequest.current = { fingerprint, requestId };
      setRequestRevision((revision) => revision + 1);
    }

    saveInFlight.current = true;
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(null);
    const request: SaveCalculationInput = {
      leadId: lead.id,
      inputs: copyInputs(inputs),
      decision: copyDecision(decision),
      provenance: { ...nextProvenance, leadId: lead.id },
      requestId,
      parentId,
    };
    try {
      const result = await saveCalculation(request);
      if (!result.ok) {
        if (formRevision.current === revisionAtStart) setSaveError(result.error);
        return;
      }
      if (formRevision.current !== revisionAtStart) {
        // A lead or field changed while the request was in flight. Keep the
        // response in the timeline, but never rewind the newer worksheet.
        setSaveSuccess("The previous revision saved. Your newer lead or entries are still here.");
        return;
      }
      setSavedSnapshot(result.data);
      setBaselineInputs(copyInputs(result.data.inputs));
      setInputs(copyInputs(result.data.inputs));
      setDraftInputs(draftsFromInputs(result.data.inputs));
      setDraftListingPercentage(formatListingPercentage(result.data.inputs.listingPercentage));
      setDecision(copyDecision(result.data.decision));
      setDraftProposedOffer(inputValue(result.data.decision.proposedOffer));
      setDraftErrors({});
      setProvenance(result.data.provenance);
      setSaveSuccess(`Saved revision v${result.data.version} to ${lead.address}.`);
      saveRequest.current = null;
    } catch {
      if (formRevision.current === revisionAtStart) {
        setSaveError("Could not save this calculation. Your entries are still here; retry to use the same request.");
      }
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  };

  const setDecisionValue = <K extends keyof CalculatorDecision>(
    key: K,
    value: CalculatorDecision[K],
  ) => {
    if (saving || saveInFlight.current) return;
    formRevision.current += 1;
    setDecision((previous) => ({ ...previous, [key]: value }));
    setSaveError(null);
    setSaveSuccess(null);
  };

  return (
    <div className={styles.workspace} data-testid="calculator-workspace">
      <PageHeader
        breadcrumb={[{ label: "Workspace" }, { label: "Calculators" }]}
        title="Offer Calculator"
        context={
          <div className={styles.leadArea}>
            {lead ? (
              <div className={styles.leadChip} data-testid="attached-lead">
                <span className={styles.leadIcon}><Home size={16} aria-hidden="true" /></span>
                <span className={styles.leadDetails}>
                  <span className={styles.leadAddress}>{lead.address}</span>
                  <span className={styles.leadMeta}>{lead.seller} · {lead.status}</span>
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className={styles.changeButton}
                  disabled={saving}
                  onClick={() => setLeadPickerOpen((open) => !open)}
                >
                  Change
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className={styles.detachButton}
                  aria-label="Detach lead"
                  disabled={saving}
                  onClick={detachLead}
                >
                  <X size={14} aria-hidden="true" />
                </Button>
              </div>
            ) : (
              <div className={styles.noLeadBanner} data-testid="no-lead-banner">
                <Link2 size={16} aria-hidden="true" />
                <span>No lead attached — a calculation is always saved to a lead.</span>
                <Button type="button" size="sm" disabled={saving} onClick={() => setLeadPickerOpen(true)}>Attach a lead</Button>
              </div>
            )}
            {provenance && lead && (
              <span className={styles.provenance}>
                <Info size={13} aria-hidden="true" />
                {leadProvenanceLabel(provenance)}
              </span>
            )}
            {leadPickerOpen && (
              <div className={styles.leadPicker} role="dialog" aria-label="Attach a lead">
                <div className={styles.searchRow}>
                  <Search size={15} aria-hidden="true" />
                  <input
                    autoFocus
                    aria-label="Search leads by address or name"
                    disabled={saving}
                    value={leadSearch}
                    onChange={(event) => {
                      setLeadSearch(event.target.value);
                      setRemoteLeads(null);
                    }}
                    placeholder="Search leads by address or name"
                  />
                </div>
                <div className={styles.leadResults}>
                  {leadSearchPending && <p className={styles.pickerHint}>Searching leads…</p>}
                  {leadSearchError && <p className={styles.pickerError}>{leadSearchError}</p>}
                  {!leadSearchPending && !leadSearchError && visibleLeads.length === 0 && (
                    <p className={styles.pickerHint}>No eligible leads found.</p>
                  )}
                  {!leadSearchPending && visibleLeads.map((candidate) => (
                    <button
                      key={candidate.id}
                      type="button"
                      className={styles.leadResult}
                      disabled={saving}
                      onClick={() => selectLead(candidate)}
                    >
                      <span className={styles.resultIcon}><Home size={14} aria-hidden="true" /></span>
                      <span className={styles.leadDetails}>
                        <span className={styles.leadAddress}>{candidate.address}</span>
                        <span className={styles.leadMeta}>{candidate.seller} · {candidate.status}</span>
                      </span>
                      <ChevronRight size={15} aria-hidden="true" />
                    </button>
                  ))}
                </div>
                <div className={styles.pickerFooter}>
                  {lead && <Button type="button" variant="ghost" size="sm" disabled={saving} className={styles.detachFooterButton} onClick={detachLead}>Detach lead</Button>}
                  <span>Opening from a lead attaches it automatically.</span>
                </div>
              </div>
            )}
          </div>
        }
        actions={<div className={styles.headerActions}>
          <div className={styles.actionButtons}>
            <Button type="button" variant="outline" size="sm" onClick={() => setGuideOpen(true)}>
              <CircleHelp size={15} aria-hidden="true" /> Guide
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={saving} onClick={reset}>
              <RotateCcw size={15} aria-hidden="true" /> Reset
            </Button>
            <Button type="button" size="sm" onClick={() => void handleSave()} disabled={!lead || saving}>
              {saving ? <span role="status">Saving…</span> : <><Save size={15} aria-hidden="true" /> {saveError ? "Retry save" : "Save to lead"}</>}
            </Button>
          </div>
          <div className={styles.legend} aria-label="Cell colors">
            <span><i className={`${styles.legendSwatch} ${styles.editableSwatch}`} />Blue: editable</span>
            <span><i className={`${styles.legendSwatch} ${styles.resultSwatch}`} />Yellow: calculated</span>
          </div>
        </div>}
      />

      {(saveError || saveSuccess || Object.keys(draftErrors).length > 0) && (
        <div className={saveError || Object.keys(draftErrors).length > 0 ? styles.errorBanner : styles.successBanner} role={saveError || Object.keys(draftErrors).length > 0 ? "alert" : "status"}>
          {saveError || Object.keys(draftErrors).length > 0 ? <AlertTriangle size={17} aria-hidden="true" /> : <Check size={17} aria-hidden="true" />}
          <span>{saveError ?? saveSuccess ?? (() => {
            const [key, message] = Object.entries(draftErrors)[0] ?? [];
            if (!key || !message) return "Fix the highlighted fields before continuing.";
            const label = key === "listingPercentage"
              ? "Listing percentage"
              : key === "proposedOffer"
                ? "Proposed offer"
                : EXPENSE_FIELD_LABELS.get(key) ?? key;
            return `${label}: ${message}`;
          })()}</span>
        </div>
      )}

      {!inputs.asIs || !inputs.arv ? (
        <div className={styles.notice} role="status">
          <AlertTriangle size={18} aria-hidden="true" />
          <span>
            Enter {!inputs.asIs && !inputs.arv ? "as-is market value and ARV" : !inputs.asIs ? "as-is market value" : "ARV"} to complete the calculation. Blank inputs are treated as $0 — results may be partial.
          </span>
        </div>
      ) : null}

      <div className={styles.worksheetGrid}>
        <section className={styles.panel} aria-labelledby="novation-title">
          <h2 className={styles.panelTitle} id="novation-title">NOVATION</h2>
          <MoneyInputRow disabled={saving} label="As-is market value" value={draftInputs.asIs} error={draftErrors.asIs} onChange={(value) => updateInput("asIs", value)} onBlur={() => validateInputDraft("asIs")} />
          <div className={styles.rowline}>
            <span className={styles.rowLabel}>
              Listing percentage
              <button
                type="button"
                className={`${styles.lockBadge} ${!listingLocked ? styles.lockBadgeOpen : ""}`}
                aria-label={listingLocked ? "Unlock listing percentage" : "Lock listing percentage"}
                aria-pressed={!listingLocked}
                disabled={saving}
                onClick={() => setListingLocked((locked) => !locked)}
              >
                {listingLocked ? <Lock size={11} aria-hidden="true" /> : <LockKeyholeOpen size={11} aria-hidden="true" />}
                {listingLocked ? "locked" : "editable"}
              </button>
            </span>
            <span className={`${styles.rowValue} ${listingLocked ? styles.lockedValue : styles.editableValue}`}>
              {listingLocked ? <span>{inputs.listingPercentage == null ? "" : `${formatListingPercentage(inputs.listingPercentage)}%`}</span> : <><input disabled={saving} aria-label="Listing percentage" className={styles.cellInput} inputMode="decimal" value={draftListingPercentage} aria-invalid={Boolean(draftErrors.listingPercentage)} onChange={(event) => updateListingPercentage(event.target.value)} onBlur={validateListingDraft} /><span>%</span></>}
            </span>
          </div>
          <MoneyInputRow disabled={saving} label="Desired profit" value={draftInputs.profit} error={draftErrors.profit} onChange={(value) => updateInput("profit", value)} onBlur={() => validateInputDraft("profit")} />
          <div className={styles.sectionBar}>Expenses</div>
          <div className={styles.rowline}>
            <span className={styles.rowLabel}>Commission (4% of as-is value)</span>
            <span data-testid="result-commission" className={`${styles.rowValue} ${styles.resultValue}`}>{resultAmount(results.commission)}</span>
          </div>
          {EXPENSE_FIELDS.map(([key]) => (
            <MoneyInputRow disabled={saving} key={key} label={EXPENSE_FIELD_LABELS.get(key) ?? key} value={draftInputs[key]} error={draftErrors[key]} onChange={(value) => updateInput(key, value)} onBlur={() => validateInputDraft(key)} />
          ))}
          <ResultRow label="Itemized expenses" value={resultAmount(results.expenses)} testId="result-expenses" />
          <div className={styles.rowline}>
            <span className={`${styles.rowLabel} ${styles.bold}`}>Listing price</span>
            <span data-testid="result-listing" className={`${styles.rowValue} ${styles.resultValue} ${styles.bold}`}>{resultAmount(results.listing)}</span>
          </div>
          <div className={styles.sectionBar}>Program amounts</div>
          <div className={styles.table}>
            <div className={styles.tableHead}><span>Program</span><span>Offer range</span><span>Amount</span></div>
            {PROGRAMS.map((program) => (
              <div className={styles.tableRow} key={program.value}>
                <span>{program.label}</span><span className={styles.mutedCenter}>{program.range}</span><span data-testid={`result-${program.result}`} className={`${styles.amount} ${styles.resultCell}`}>{resultAmount(results[program.result])}</span>
              </div>
            ))}
          </div>
          <p className={styles.footnote}>Negotiation anchors; the proposed offer and negotiated terms are recorded separately. Terms explained in Guide.</p>
        </section>

        <section className={styles.panel} aria-labelledby="wholesale-title">
          <h2 className={styles.panelTitle} id="wholesale-title">WHOLESALE</h2>
          <MoneyInputRow disabled={saving} label="ARV (after-repair value)" value={draftInputs.arv} error={draftErrors.arv} onChange={(value) => updateInput("arv", value)} onBlur={() => validateInputDraft("arv")} />
          <MoneyInputRow disabled={saving} label="Investor rehab" value={draftInputs.rehab} error={draftErrors.rehab} onChange={(value) => updateInput("rehab", value)} onBlur={() => validateInputDraft("rehab")} />
          <div className={styles.sectionBar}>Calculations</div>
          <ResultRow label="ARV × 70%" value={resultAmount(results.arv70)} testId="result-arv70" />
          <ResultRow label="Less rehab" value={resultAmount(inputs.rehab ?? 0)} />
          <ResultRow label="Investor price" value={resultAmount(results.investor)} emphasized testId="result-investor" />
          <div className={styles.sectionBar}>Seller offers by fee</div>
          <div className={styles.tableTwoColumn}>
            <div className={styles.tableHead}><span>Your fee</span><span>Seller offer</span></div>
            {FEE_TIERS.map((fee) => (
              <div className={styles.tableRow} key={fee}>
                <span>{formatDollars(fee)}</span><span data-testid={`result-fee${fee}`} className={`${styles.amount} ${styles.resultCell}`}>{resultAmount(results.offers[`fee${fee}` as keyof CalculatorResults["offers"]])}</span>
              </div>
            ))}
          </div>
          <div className={styles.sectionBar}>Rehab estimate reference</div>
          <p className={styles.tableIntro}>Square feet · estimates in $ thousands</p>
          <div className={styles.rehabTable}>
            <span className={styles.tableHeadCell}>Condition</span>
            {["< 1,500", "1,500–2,500", "2,500–3,500", "3,500–5,000", "> 5,000"].map((heading) => <span className={styles.tableHeadCell} key={heading}>{heading}</span>)}
            {REHAB_REFERENCE.flatMap((row) => [
              <span className={styles.conditionCell} key={`${row.condition}-label`}>{row.condition}</span>,
              ...row.values.map((value, index) => <span className={styles.referenceCell} key={`${row.condition}-${index}`}>{value}</span>),
            ])}
          </div>
          <p className={styles.footnote}>Reference only. Enter your rehab estimate above. Investor rehab is separate from novation buyer-requested repairs.</p>
        </section>
      </div>

      <section className={styles.decisionPanel} aria-labelledby="decision-title">
        <div className={styles.decisionHeader}>
          <div><h2 id="decision-title">DECISION &amp; RECORD</h2><p>Choose the path and record the negotiated proposal separately from worksheet anchors.</p></div>
          {savedSnapshot && <span className={styles.revisionBadge}>Revision v{savedSnapshot.version}</span>}
        </div>
        <div className={styles.decisionGrid}>
          <fieldset className={styles.approachFieldset}>
            <legend>Approach</legend>
            <div className={styles.approachChoices}>
              {(["novation", "wholesale"] as const).map((approach) => (
                <label className={`${styles.approachChoice} ${decision.approach === approach ? styles.approachSelected : ""}`} key={approach}>
                  <input disabled={saving} type="radio" name="approach" value={approach} checked={decision.approach === approach} onChange={() => setDecisionValue("approach", approach)} />
                  <span>{approach === "novation" ? "Novation" : "Wholesale"}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <label className={styles.formField}><span>Seller program</span><select disabled={saving} value={decision.program} onChange={(event) => setDecisionValue("program", event.target.value as CalculatorDecision["program"])}><option value="equity_protection">Equity Protection</option><option value="family_placement">Family Placement</option><option value="secure_close">Secure Close</option><option value="rapid_relief">Rapid Relief</option></select></label>
          <label className={styles.formField}><span>Fee tier</span><select disabled={saving} value={decision.feeTier} onChange={(event) => setDecisionValue("feeTier", Number(event.target.value) as CalculatorDecision["feeTier"])}><option value={40000}>$40,000</option><option value={30000}>$30,000</option><option value={20000}>$20,000</option><option value={10000}>$10,000</option></select></label>
          <label className={styles.formField}><span>Proposed offer</span><div className={styles.moneyField}><span>$</span><input disabled={saving} inputMode="decimal" aria-label="Proposed offer" value={draftProposedOffer} aria-invalid={Boolean(draftErrors.proposedOffer)} onChange={(event) => updateProposedOffer(event.target.value)} onBlur={validateProposedOfferDraft} placeholder="Optional" /></div></label>
          <label className={`${styles.formField} ${styles.wideField}`}><span>Terms</span><textarea disabled={saving} maxLength={10000} value={decision.terms} onChange={(event) => setDecisionValue("terms", event.target.value)} placeholder="Closing timing, inspection, access, or other negotiated terms" /></label>
          <label className={`${styles.formField} ${styles.wideField}`}><span>Seller motivation</span><textarea disabled={saving} maxLength={10000} value={decision.motivation} onChange={(event) => setDecisionValue("motivation", event.target.value)} placeholder="What matters most to the seller" /></label>
        </div>
      </section>

      <p className={styles.bottomHint}>Example inputs · Saving records a calculation, not an offer sent. {requestRevision > 0 ? "A changed request will receive a new retry key." : ""}</p>

      {guideOpen && (
        <div className={styles.drawerOverlay} role="presentation">
          <button type="button" className={styles.drawerBackdrop} aria-label="Close Guide" onClick={() => setGuideOpen(false)} />
          <aside ref={guideDrawerRef} className={styles.guideDrawer} aria-label="Calculator guide" aria-modal="true" role="dialog">
            <div className={styles.drawerHeader}><span><BookOpen size={17} aria-hidden="true" />Guide</span><Button ref={guideCloseRef} type="button" variant="ghost" size="icon-sm" aria-label="Close Guide" onClick={() => setGuideOpen(false)}><X size={17} aria-hidden="true" /></Button></div>
            <div className={styles.drawerBody}>
              <GuideStep title="Step 1 · Pick the path">Novation is for an as-is MLS sale to a retail or investor buyer. Wholesale evaluates an investor purchase using ARV, rehab, and fee tiers. Compare both approaches; property condition alone does not decide it.</GuideStep>
              <GuideStep title="Step 2 · As-is market value">Enter what the property sells for today, as-is, using true as-is comps. This drives listing price and commission.</GuideStep>
              <GuideStep title="Step 3 · Novation inputs">Desired profit starts at $20,000 for many deals. Enter the real expenses you pay and any known buyer-requested repairs for the novation plan.</GuideStep>
              <GuideStep title="Step 4 · Wholesale side">Enter ARV from renovated comps and the investor rehab budget. The calculator returns investor price and fee tiers for comparison.</GuideStep>
              <GuideStep title="Step 5 · Fixed settings">The listing factor defaults to 90% and commission is fixed at 4%, matching the worksheet. Click the lock to adjust the listing factor when needed.</GuideStep>
              <GuideStep title="Step 6 · Decide & record">Program amounts are anchors. Record the approach, program, proposed offer, and negotiated terms when you save — they are different from the anchors.</GuideStep>
              <div className={styles.commonMistakes}><span>Common mistakes</span><p>Don’t put ARV comps in as-is value. Keep the wholesale rehab budget separate from novation buyer-requested repairs. Record timing, inspection, access, and other negotiated terms with the proposed offer.</p></div>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

function MoneyInputRow({ label, value, onChange, onBlur, error, disabled = false }: { label: string; value: string; onChange: (value: string) => void; onBlur?: () => void; error?: string; disabled?: boolean }) {
  const inputId = `calculator-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
  return <div className={styles.rowline}><label className={styles.rowLabel} htmlFor={inputId}>{label}</label><span className={`${styles.rowValue} ${styles.editableValue}`}><span className={styles.currency}>$</span><input disabled={disabled} id={inputId} className={styles.cellInput} inputMode="decimal" value={value} aria-invalid={Boolean(error)} title={error} onChange={(event) => onChange(event.target.value)} onBlur={onBlur} /></span></div>;
}

function ResultRow({ label, value, emphasized = false, testId }: { label: string; value: string; emphasized?: boolean; testId?: string }) {
  return <div className={styles.rowline}><span className={`${styles.rowLabel} ${emphasized ? styles.bold : ""}`}>{label}</span><span data-testid={testId} className={`${styles.rowValue} ${styles.resultValue} ${emphasized ? styles.bold : ""}`}>{value}</span></div>;
}

function GuideStep({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className={styles.guideStep}><strong>{title}</strong><p>{children}</p></div>;
}
