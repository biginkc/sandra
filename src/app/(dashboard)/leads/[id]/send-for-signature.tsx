"use client";

import { FileSignatureIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { callAction } from "@/lib/errors/call-action";
import { isValidEsignEmail } from "@/lib/esign/email";
import {
  cancelPendingDialogClose,
  type DialogCloseEventDetails,
} from "@/lib/esign/pending-dialog";
import type {
  EsignMergeFieldName,
  TemplateOption,
} from "@/lib/esign/contracts";

import {
  primarySendBlocker,
  sendBlockerMessage,
  type ContractMergeValues,
  type LeadEsignPreflight,
  type LoadLeadEsignPreflightAction,
  type SendBlockerCode,
  type SendContractAction,
  type SignerAssignment,
} from "./esign-types";

const MERGE_FIELDS: ReadonlyArray<{
  name: EsignMergeFieldName;
  label: string;
  type: "text" | "date";
  placeholder?: string;
}> = [
  { name: "seller_name", label: "Seller name", type: "text" },
  { name: "property_address", label: "Property address", type: "text" },
  {
    name: "offer_price",
    label: "Offer price",
    type: "text",
    placeholder: "$0.00",
  },
  { name: "closing_date", label: "Closing date", type: "date" },
  {
    name: "earnest_money",
    label: "Earnest money",
    type: "text",
    placeholder: "$0.00",
  },
];

type Props = {
  propertyId: string;
  initialBlockers: readonly SendBlockerCode[];
  preflightAction: LoadLeadEsignPreflightAction;
  sendAction: SendContractAction;
  onFinished?: (requestId: string) => void;
};

export function SendForSignature({
  propertyId,
  initialBlockers,
  preflightAction,
  sendAction,
  onFinished,
}: Props) {
  const [open, setOpen] = useState(false);
  const initialBlocker = primarySendBlocker(
    initialBlockers.filter((blocker) => blocker !== "owner_email_missing"),
  );

  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={initialBlocker !== null}
        onClick={() => setOpen(true)}
        data-testid="send-for-signature-trigger"
      >
        <FileSignatureIcon className="size-4" aria-hidden />
        Send for signature
      </Button>
      {initialBlocker ? (
        <p
          className="max-w-64 text-xs text-muted-foreground"
          data-testid="send-for-signature-disabled-reason"
        >
          {sendBlockerMessage(initialBlocker)}
        </p>
      ) : null}
      <SendForSignatureDialog
        open={open}
        onOpenChange={setOpen}
        propertyId={propertyId}
        preflightAction={preflightAction}
        sendAction={sendAction}
        onFinished={onFinished}
      />
    </div>
  );
}

type DialogProps = Omit<Props, "initialBlockers"> & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function SendForSignatureDialog({
  open,
  onOpenChange,
  propertyId,
  preflightAction,
  sendAction,
  onFinished,
}: DialogProps) {
  const [preflight, setPreflight] = useState<LeadEsignPreflight | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [mergeValues, setMergeValues] = useState<ContractMergeValues | null>(
    null,
  );
  const [signers, setSigners] = useState<SignerAssignment[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [sendIntentId, setSendIntentId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const openRef = useRef(open);
  const propertyIdRef = useRef(propertyId);
  const requestSequenceRef = useRef(0);

  useEffect(() => {
    openRef.current = open;
    propertyIdRef.current = propertyId;
  }, [open, propertyId]);

  const reset = () => {
    setPreflight(null);
    setSelectedTemplateId("");
    setMergeValues(null);
    setSigners([]);
    setConfirmed(false);
    setLoading(false);
    setError(null);
    setSendIntentId(null);
  };

  const loadPreflight = () => {
    if (!open) return;
    const requestedPropertyId = propertyId;
    const requestSequence = requestSequenceRef.current + 1;
    requestSequenceRef.current = requestSequence;
    setLoading(true);
    setError(null);
    setPreflight(null);
    setConfirmed(false);

    void (async () => {
      let result: Awaited<ReturnType<LoadLeadEsignPreflightAction>>;
      try {
        result = await preflightAction(requestedPropertyId);
      } catch (cause) {
        if (!isCurrentRequest(requestSequence, requestedPropertyId)) return;
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not load the contract preflight.",
        );
        setLoading(false);
        return;
      }
      if (!isCurrentRequest(requestSequence, requestedPropertyId)) return;
      if (!result.ok) {
        setError(result.error.message);
        setLoading(false);
        return;
      }

      const next = result.data;
      setPreflight(next);
      setMergeValues({ ...next.mergeDefaults });
      const firstTemplate = next.templates[0] ?? null;
      setSelectedTemplateId(firstTemplate?.id ?? "");
      setSigners(firstTemplate ? assignmentsFor(firstTemplate, next) : []);
      setSendIntentId(createSendIntentId());
      setLoading(false);
    })();
  };

  const isCurrentRequest = (sequence: number, requestedPropertyId: string) =>
    requestSequenceRef.current === sequence &&
    propertyIdRef.current === requestedPropertyId &&
    openRef.current;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) loadPreflight();
    });
    return () => {
      cancelled = true;
    };
    // `loadPreflight` intentionally snapshots the injected action and property.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, propertyId]);

  const handleOpenChange = (
    next: boolean,
    eventDetails: DialogCloseEventDetails,
  ) => {
    if (cancelPendingDialogClose(next, pending, eventDetails)) return;
    if (!next) reset();
    onOpenChange(next);
  };

  const requestClose = () => {
    if (pending) return;
    reset();
    onOpenChange(false);
  };

  const closeAfterSuccess = () => {
    reset();
    onOpenChange(false);
  };

  const selectedTemplate = useMemo(
    () =>
      preflight?.templates.find(
        (template) => template.id === selectedTemplateId,
      ) ?? null,
    [preflight, selectedTemplateId],
  );
  const sellerSigner = selectedTemplate
    ? signers.find((signer) => signer.role === selectedTemplate.sellerRoleName)
    : null;
  const blocker =
    primarySendBlocker(
      (preflight?.blockers ?? []).filter(
        (candidate) => candidate !== "owner_email_missing",
      ),
    ) ??
    (preflight && selectedTemplate && !sellerSigner?.emailAddress.trim()
      ? "owner_email_missing"
      : null);
  const fieldsComplete =
    mergeValues !== null &&
    MERGE_FIELDS.every(({ name }) => mergeValues[name].trim().length > 0);
  const signersComplete =
    selectedTemplate !== null &&
    signers.length === selectedTemplate.signerRoles.length &&
    signers.every(
      (signer) =>
        signer.name.trim().length > 0 && isValidEsignEmail(signer.emailAddress),
    );
  const canSend =
    !loading &&
    !pending &&
    blocker === null &&
    confirmed &&
    fieldsComplete &&
    signersComplete &&
    Boolean(sendIntentId);

  const selectTemplate = (templateId: string) => {
    setSelectedTemplateId(templateId);
    setConfirmed(false);
    const template = preflight?.templates.find(
      (candidate) => candidate.id === templateId,
    );
    if (template && preflight) {
      setSigners(assignmentsFor(template, preflight));
    } else {
      setSigners([]);
    }
  };

  const send = () => {
    if (!canSend || !mergeValues || !selectedTemplate) return;
    if (!sendIntentId) return;

    startTransition(async () => {
      const result = await callAction(
        sendAction({
          propertyId,
          templateId: selectedTemplate.id,
          sendIntentId,
          signers: [...signers].sort((a, b) => a.order - b.order),
          mergeValues,
        }),
        {
          successMessage: "Contract sent for signature",
          fallbackMessage: "Could not send the contract",
        },
      );
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      const requestId = result.data.requestId;
      closeAfterSuccess();
      onFinished?.(requestId);
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={handleOpenChange}
      disablePointerDismissal={pending}
    >
      <DialogContent
        className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-2xl"
        showCloseButton={!pending}
      >
        <DialogHeader>
          <DialogTitle>Send for signature</DialogTitle>
          <DialogDescription>
            Review the template, recipients, and contract values before sending.
          </DialogDescription>
        </DialogHeader>

        {loading || pending ? (
          <p
            role="status"
            aria-live="polite"
            aria-busy="true"
            className="py-6 text-sm text-muted-foreground"
          >
            {pending
              ? "Sending contract for signature…"
              : "Checking templates and sending access…"}
          </p>
        ) : error && !preflight ? (
          <div className="space-y-3 py-4">
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
            <Button type="button" variant="outline" onClick={loadPreflight}>
              <RefreshCwIcon className="size-4" aria-hidden />
              Try again
            </Button>
          </div>
        ) : preflight ? (
          <div className="min-w-0 space-y-5">
            {preflight.testMode ? (
              <div
                className="rounded-md border border-alert-warning/40 bg-alert-warning/10 px-3 py-2 text-sm"
                data-testid="esign-test-mode-notice"
              >
                Dropbox Sign is in test mode. This document is watermarked and
                not legally binding.
              </div>
            ) : (
              <div
                className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm"
                data-testid="esign-live-mode-notice"
              >
                Dropbox Sign is in live mode. This send is legally binding and
                counts against Dropbox Sign billing. Sandra&apos;s fuse covers
                Sandra-originated sends only.
                {preflight.liveSendLimit ? (
                  <span className="mt-1 block text-xs text-muted-foreground">
                    Sandra local calendar-month ceiling: {preflight.liveSendLimit.usedThisMonth} of {preflight.liveSendLimit.monthlyLimit} live sends used.
                  </span>
                ) : null}
              </div>
            )}

            {blocker ? (
              <p role="alert" className="text-sm text-destructive">
                {sendBlockerMessage(blocker)}
              </p>
            ) : null}

            <div className="space-y-2">
              <Label htmlFor="esign-template">Template</Label>
              <select
                id="esign-template"
                value={selectedTemplateId}
                onChange={(event) => selectTemplate(event.target.value)}
                disabled={preflight.templates.length === 0}
                className="border-input bg-background h-9 w-full rounded-lg border px-3 text-sm"
              >
                {preflight.templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
              </select>
            </div>

            {selectedTemplate ? (
              <fieldset className="space-y-3 rounded-lg border p-3">
                <legend className="px-1 text-sm font-semibold">Signers</legend>
                <p className="text-xs text-muted-foreground">
                  Every role in this template is required. Signers receive the
                  document in the provider-defined order shown below.
                </p>
                {signers.map((signer, index) => (
                  <div
                    key={signer.role}
                    className="grid gap-3 rounded-md bg-muted/40 p-3 sm:grid-cols-2"
                    data-testid={`esign-signer-${signer.order}`}
                  >
                    <div className="sm:col-span-2 text-xs font-semibold text-muted-foreground">
                      {signer.order + 1}. {signer.role}
                      {signer.role === selectedTemplate.sellerRoleName
                        ? " · Seller"
                        : ""}
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`esign-signer-name-${index}`}>Name</Label>
                      <Input
                        id={`esign-signer-name-${index}`}
                        value={signer.name}
                        onChange={(event) =>
                          updateSigner(index, { name: event.target.value })
                        }
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`esign-signer-email-${index}`}>
                        Email
                      </Label>
                      <Input
                        id={`esign-signer-email-${index}`}
                        type="email"
                        value={signer.emailAddress}
                        required
                        aria-invalid={
                          isValidEsignEmail(signer.emailAddress)
                            ? undefined
                            : true
                        }
                        aria-describedby={
                          isValidEsignEmail(signer.emailAddress)
                            ? undefined
                            : `esign-signer-email-error-${index}`
                        }
                        onChange={(event) =>
                          updateSigner(index, {
                            emailAddress: event.target.value,
                          })
                        }
                      />
                      {!isValidEsignEmail(signer.emailAddress) ? (
                        <p
                          id={`esign-signer-email-error-${index}`}
                          className="text-xs text-destructive"
                        >
                          Enter one email address without spaces.
                        </p>
                      ) : null}
                    </div>
                  </div>
                ))}
              </fieldset>
            ) : null}

            {mergeValues ? (
              <fieldset className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2">
                <legend className="px-1 text-sm font-semibold">
                  Contract values
                </legend>
                {MERGE_FIELDS.map((field) => (
                  <div
                    key={field.name}
                    className={
                      field.name === "property_address" ? "sm:col-span-2" : ""
                    }
                  >
                    <Label htmlFor={`esign-merge-${field.name}`}>
                      {field.label}
                    </Label>
                    <Input
                      id={`esign-merge-${field.name}`}
                      name={field.name}
                      type={field.type}
                      placeholder={field.placeholder}
                      value={mergeValues[field.name]}
                      onChange={(event) =>
                        updateMergeValue(field.name, event.target.value)
                      }
                      className="mt-1.5"
                    />
                  </div>
                ))}
              </fieldset>
            ) : null}

            <label className="flex items-start gap-2 rounded-md border p-3 text-sm">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
                className="accent-primary mt-0.5 size-4"
              />
              <span>I reviewed the recipients and contract details.</span>
            </label>

            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={requestClose}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!canSend}
            onClick={send}
            data-testid="send-for-signature-submit"
          >
            Send for signature
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  function updateSigner(
    index: number,
    update: Partial<Pick<SignerAssignment, "name" | "emailAddress">>,
  ) {
    setSigners((current) =>
      current.map((signer, signerIndex) =>
        signerIndex === index ? { ...signer, ...update } : signer,
      ),
    );
    setConfirmed(false);
  }

  function updateMergeValue(name: EsignMergeFieldName, value: string) {
    setMergeValues((current) =>
      current ? { ...current, [name]: value } : current,
    );
    setConfirmed(false);
  }
}

function assignmentsFor(
  template: TemplateOption,
  preflight: LeadEsignPreflight,
): SignerAssignment[] {
  return [...template.signerRoles]
    .sort((a, b) => a.order - b.order)
    .map((role) => ({
      role: role.name,
      order: role.order,
      name:
        role.name === template.sellerRoleName
          ? preflight.sellerDefaults.name
          : "",
      emailAddress:
        role.name === template.sellerRoleName
          ? preflight.sellerDefaults.emailAddress
          : "",
    }));
}

function createSendIntentId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `send-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
