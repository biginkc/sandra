"use client";

import Link from "next/link";
import { useRef, useState } from "react";

import { Button, buttonVariants } from "@/components/ui/button";

import type { OfferRecoveryResult } from "../types";

export type OfferRecoveryTarget = {
  projectionId: string;
  propertyId: string;
  conflictCode: string | null;
  requestId: string | null;
  amountCents: number;
  pendingOfferAmountCents: number | null;
};

export type OfferRecoveryActions = {
  retry: (projectionId: string) => Promise<OfferRecoveryResult>;
  supersede: (projectionId: string, idempotencyKey: string) => Promise<OfferRecoveryResult>;
  reassign: (projectionId: string) => Promise<OfferRecoveryResult>;
  cancel: (requestId: string) => Promise<OfferRecoveryResult>;
};

const usd = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `00000000-0000-4000-8000-${Date.now().toString(16).padStart(12, "0").slice(-12)}`);

/**
 * Recovery after a contract was sent but its offer could not be logged. Nothing here can send a
 * contract: the policy line says so. Used on the call screen card, the lead page and the strip.
 */
export function OfferRecovery({ target, actions, onDone }: { target: OfferRecoveryTarget; actions: OfferRecoveryActions; onDone?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  // Stable until a definitive outcome, so a double click or lost response replays the same supersede.
  const keyRef = useRef<string | null>(null);

  const code = target.conflictCode;
  const run = async (fn: () => Promise<OfferRecoveryResult>, rotateKey = false) => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fn();
      if (res.ok) {
        keyRef.current = null;
        setConfirming(false);
        onDone?.();
      } else {
        if (rotateKey) keyRef.current = null;
        setMessage(res.message);
      }
    } catch {
      setMessage("That did not work. Nothing was changed.");
    } finally {
      setBusy(false);
    }
  };

  const cancel = target.requestId ? (
    <Button type="button" variant="outline" size="sm" data-testid="recovery-cancel" disabled={busy}
      onClick={() => run(() => actions.cancel(target.requestId!))}>
      Cancel signature request
    </Button>
  ) : null;
  const openLead = (
    <Link href={`/leads/${target.propertyId}`} data-testid="recovery-open-lead" className={buttonVariants({ variant: "outline", size: "sm" })}>Open lead</Link>
  );

  let buttons: React.ReactNode;
  if (code === "PENDING_OFFER_EXISTS") {
    buttons = (
      <>
        <Button type="button" size="sm" data-testid="recovery-supersede" disabled={busy} onClick={() => setConfirming(true)}>
          Supersede stale offer and log this one
        </Button>
        {cancel}
      </>
    );
  } else if (code === "STALE_ASSIGNMENT") {
    buttons = (
      <>
        <Button type="button" size="sm" data-testid="recovery-reassign" disabled={busy} onClick={() => run(() => actions.reassign(target.projectionId))}>
          Reassign to me and log
        </Button>
        {cancel}
      </>
    );
  } else if (code === "STALE_STATE" || code === "DNC_LOCKED" || code === "AMOUNT_MISMATCH") {
    buttons = (<>{cancel}{openLead}</>);
  } else {
    buttons = (
      <Button type="button" size="sm" data-testid="recovery-retry" disabled={busy} onClick={() => run(() => actions.retry(target.projectionId))}>
        Retry logging
      </Button>
    );
  }

  return (
    <div data-testid="offer-recovery" className="border-destructive/40 space-y-2 rounded-md border p-3">
      <p role="alert" className="text-destructive text-sm font-medium">Contract sent, offer needs reconciling</p>
      <p className="text-muted-foreground text-xs" data-testid="recovery-policy">The contract was sent. Sandra never sends it again.</p>
      <div className="flex flex-wrap gap-2">{buttons}</div>
      {confirming ? (
        <div data-testid="recovery-confirm" className="space-y-2 rounded-md border p-2 text-xs">
          <p>
            This lead has a pending offer of {target.pendingOfferAmountCents != null ? usd(target.pendingOfferAmountCents) : "an unknown amount"}.
            The contract you sent is for {usd(target.amountCents)}. Superseding marks the old offer as superseded and logs the new one.
          </p>
          <div className="flex gap-2">
            <Button type="button" size="sm" data-testid="recovery-confirm-supersede" disabled={busy}
              onClick={() => run(() => actions.supersede(target.projectionId, (keyRef.current ??= newKey())), true)}>
              Confirm
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setConfirming(false)}>Back</Button>
          </div>
        </div>
      ) : null}
      {message ? <p role="status" data-testid="recovery-message" className="text-xs">{message}</p> : null}
    </div>
  );
}

/** Strip/lead-page list of conflicts the signed-in rep can act on (rows come from fn_list_offer_conflicts). */
export function OfferConflictRows({
  rows, actions, onDone,
}: {
  rows: { projectionId: string; propertyId: string; address: string | null; conflictCode: string | null; requestId: string | null; amountCents: number; pendingOfferAmountCents: number | null }[];
  actions: OfferRecoveryActions;
  onDone?: () => void;
}) {
  if (rows.length === 0) return null;
  return (
    <div data-testid="offer-conflict-rows" className="space-y-2">
      {rows.map((r) => (
        <div key={r.projectionId} className="space-y-1">
          <p className="text-sm font-medium">{r.address ?? "Lead"}</p>
          <OfferRecovery target={r} actions={actions} onDone={onDone} />
        </div>
      ))}
    </div>
  );
}
