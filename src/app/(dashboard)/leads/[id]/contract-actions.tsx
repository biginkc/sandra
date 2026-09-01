"use client";

import {
  DownloadIcon,
  ExternalLinkIcon,
  MoreHorizontalIcon,
  RefreshCwIcon,
  SendIcon,
  ShieldXIcon,
} from "lucide-react";
import { useMemo, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { callAction } from "@/lib/errors/call-action";
import {
  navigateAuthorizedPopup,
  openAuthorizedPopup,
} from "@/lib/esign/authorized-popup";
import {
  cancelPendingDialogClose,
  type DialogCloseEventDetails,
} from "@/lib/esign/pending-dialog";

import type {
  ContractActionHandlers,
  ContractSignerView,
  LeadContractRow,
} from "./esign-types";

type ActionMode = "remind" | "void" | "retry" | null;

type Props = {
  contract: LeadContractRow;
  actions: ContractActionHandlers;
  onChanged?: () => void;
};

export function ContractActions({ contract, actions, onChanged }: Props) {
  const [mode, setMode] = useState<ActionMode>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const reminderTarget = useMemo(
    () => nextReminderTarget(contract.signers),
    [contract.signers],
  );

  const delivered = contract.deliveryState === "sent";
  const terminal = ["signed", "declined", "voided", "error"].includes(
    contract.status,
  );
  const canRemind =
    delivered &&
    !terminal &&
    !contract.voidRequestedAt &&
    Boolean(reminderTarget);
  const canVoid = delivered && !terminal && !contract.voidRequestedAt;
  const canRetry = contract.deliveryState === "failed";
  const canDownload = Boolean(contract.signedPdfFileId);
  const hasAnyAction =
    contract.detailsAvailable ||
    canRemind ||
    canVoid ||
    canRetry ||
    canDownload;

  const closeAfterSuccess = () => {
    setMode(null);
    setError(null);
  };

  const requestClose = () => {
    if (pending) return;
    closeAfterSuccess();
  };

  const openMode = (nextMode: Exclude<ActionMode, null>) => {
    setError(null);
    setMode(nextMode);
  };

  const run = () => {
    if (!mode) return;
    startTransition(async () => {
      const result =
        mode === "remind" && reminderTarget
          ? await callAction(
              actions.remindAction({
                requestId: contract.id,
                signerId: reminderTarget.id,
              }),
              {
                successMessage: `Reminder sent to ${reminderTarget.name}`,
                fallbackMessage: "Could not send the reminder",
              },
            )
          : mode === "void"
            ? await callAction(actions.voidAction({ requestId: contract.id }), {
                successMessage: "Void requested",
                fallbackMessage: "Could not request the void",
              })
            : mode === "retry"
              ? await callAction(
                  actions.retryAction({ requestId: contract.id }),
                  {
                    successMessage: "Contract retry started",
                    fallbackMessage: "Could not retry the contract",
                  },
                )
              : null;
      if (!result) return;
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      closeAfterSuccess();
      onChanged?.();
    });
  };

  const download = () => {
    const fileId = contract.signedPdfFileId;
    if (!fileId) return;
    setError(null);
    const popup = openAuthorizedPopup();
    if (!popup) {
      setError(
        "Your browser blocked the signed PDF window. Allow popups and try again.",
      );
      return;
    }
    startTransition(async () => {
      const result = await callAction(actions.downloadAction({ fileId }), {
        fallbackMessage: "Could not prepare the signed PDF",
      });
      if (!result.ok) {
        popup.close();
        setError(result.error.message);
        return;
      }
      if (!navigateAuthorizedPopup(popup, result.data.url)) {
        setError("Could not open the signed PDF.");
      }
    });
  };

  const view = () => {
    setError(null);
    const popup = openAuthorizedPopup();
    if (!popup) {
      setError(
        "Your browser blocked the Dropbox Sign window. Allow popups and try again.",
      );
      return;
    }
    startTransition(async () => {
      const result = await callAction(
        actions.viewAction({ requestId: contract.id }),
        {
          fallbackMessage: "Could not open Dropbox Sign details",
        },
      );
      if (!result.ok) {
        popup.close();
        setError(result.error.message);
        return;
      }
      if (!navigateAuthorizedPopup(popup, result.data.detailsUrl)) {
        setError("Could not open Dropbox Sign details.");
      }
    });
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              disabled={pending || !hasAnyAction}
              aria-label={`Actions for ${contract.templateName}`}
            >
              <MoreHorizontalIcon className="size-4" aria-hidden />
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="w-48">
          {contract.detailsAvailable ? (
            <DropdownMenuItem onClick={view}>
              <ExternalLinkIcon className="size-4" aria-hidden />
              View in Dropbox Sign
            </DropdownMenuItem>
          ) : null}
          {canDownload ? (
            <DropdownMenuItem onClick={download}>
              <DownloadIcon className="size-4" aria-hidden />
              Download signed PDF
            </DropdownMenuItem>
          ) : null}
          {contract.detailsAvailable || canDownload ? (
            <DropdownMenuSeparator />
          ) : null}
          {canRemind ? (
            <DropdownMenuItem onClick={() => openMode("remind")}>
              <SendIcon className="size-4" aria-hidden />
              Send reminder
            </DropdownMenuItem>
          ) : null}
          {canVoid ? (
            <DropdownMenuItem
              variant="destructive"
              onClick={() => openMode("void")}
            >
              <ShieldXIcon className="size-4" aria-hidden />
              Void contract
            </DropdownMenuItem>
          ) : null}
          {canRetry ? (
            <DropdownMenuItem onClick={() => openMode("retry")}>
              <RefreshCwIcon className="size-4" aria-hidden />
              Retry send
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      {error && mode === null ? (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {error}
        </p>
      ) : null}

      <Dialog
        open={mode !== null}
        onOpenChange={(open, eventDetails: DialogCloseEventDetails) => {
          if (cancelPendingDialogClose(open, pending, eventDetails)) return;
          if (!open) requestClose();
        }}
        disablePointerDismissal={pending}
      >
        <DialogContent showCloseButton={!pending}>
          <DialogHeader>
            <DialogTitle>{dialogTitle(mode)}</DialogTitle>
            <DialogDescription>
              {dialogDescription(mode, reminderTarget)}
            </DialogDescription>
          </DialogHeader>
          {mode === "void" ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
              Dropbox Sign cancellation is asynchronous. Sandra will show this
              contract as voided only after the verified cancellation callback.
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={requestClose}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant={mode === "void" ? "destructive" : "default"}
              onClick={run}
              disabled={pending}
            >
              <span role="status" aria-live="polite" aria-busy={pending}>
                {pending ? dialogPendingLabel(mode) : dialogConfirmLabel(mode)}
              </span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function nextReminderTarget(
  signers: readonly ContractSignerView[],
): ContractSignerView | null {
  return (
    [...signers]
      .sort((a, b) => a.order - b.order)
      .find(
        (signer) => signer.status === "awaiting" || signer.status === "viewed",
      ) ?? null
  );
}

function dialogTitle(mode: ActionMode): string {
  if (mode === "remind") return "Send signature reminder?";
  if (mode === "void") return "Void this contract?";
  if (mode === "retry") return "Retry this contract?";
  return "Contract action";
}

function dialogDescription(
  mode: ActionMode,
  signer: ContractSignerView | null,
): string {
  if (mode === "remind" && signer) {
    return `Dropbox Sign will email the current signer for the ${signer.role} role: ${signer.name}.`;
  }
  if (mode === "void") {
    return "This permanently cancels an incomplete Dropbox Sign request.";
  }
  if (mode === "retry") {
    return "Retry creates a new contract history row and keeps this failed attempt.";
  }
  return "Review this action before continuing.";
}

function dialogConfirmLabel(mode: ActionMode): string {
  if (mode === "remind") return "Send reminder";
  if (mode === "void") return "Request void";
  if (mode === "retry") return "Retry send";
  return "Continue";
}

function dialogPendingLabel(mode: ActionMode): string {
  if (mode === "remind") return "Sending reminder…";
  if (mode === "void") return "Requesting void…";
  if (mode === "retry") return "Retrying contract…";
  return "Working…";
}
