"use client";

import { useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import type { BuyerEntity, TitleCompany } from "@/lib/contract-defaults/resolve";
import type { EsignMergeFieldName } from "@/lib/esign/contracts";

import type { ContractCardState } from "../types";
import type { SendContractCardInput, SendContractCardResult, SignerAssignment } from "./contract-card-core";
import { buildContractPrefill, parseDollarsToCents, ECONOMIC_FIELDS } from "./contract-prefill";

type EnabledState = Extract<ContractCardState, { enabled: true }>;

export type ContractCardProps = {
  state: ContractCardState;
  propertyId: string;
  send: (input: SendContractCardInput) => Promise<SendContractCardResult>;
  onPriceChange?: (value: string) => void;
  onClosingDateChange?: (value: string) => void;
  onSent?: () => void;
};

const input = "border-input bg-background w-full rounded-md border px-2 py-1 text-sm";
const needed = <span className="text-destructive font-medium">needed</span>;

function newIntentId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `00000000-0000-4000-8000-${Date.now().toString(16).padStart(12, "0").slice(-12)}`;
}

function signersFor(state: EnabledState, buyer: BuyerEntity | null): SignerAssignment[] {
  return [...state.signerRoles].sort((a, b) => a.order - b.order).map((role) =>
    role.name === state.sellerRoleName
      ? { role: role.name, order: role.order, name: state.sellerSigner.name, emailAddress: state.sellerSigner.emailAddress }
      : { role: role.name, order: role.order, name: buyer?.name ?? "", emailAddress: buyer?.email ?? "" },
  );
}

export function ContractCard({ state, propertyId, send, onPriceChange, onClosingDateChange, onSent }: ContractCardProps) {
  if (!state.enabled) return null;
  return <EnabledCard state={state} propertyId={propertyId} send={send} onPriceChange={onPriceChange} onClosingDateChange={onClosingDateChange} onSent={onSent} />;
}

function EnabledCard({ state, propertyId, send, onPriceChange, onClosingDateChange, onSent }: ContractCardProps & { state: EnabledState }) {
  const [price, setPrice] = useState("");
  const [closingDate, setClosingDate] = useState("");
  const [titleId, setTitleId] = useState(state.selectedTitleCompanyId ?? "");
  const [buyerId, setBuyerId] = useState(state.selectedBuyerEntityId ?? "");
  const [earnest, setEarnest] = useState((state.prefillBase.settings.earnestMoneyCents / 100).toFixed(2));
  const [overrides, setOverrides] = useState<Partial<Record<EsignMergeFieldName, string>>>({});
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<SendContractCardResult | null>(null);
  // Stable across double-clicks and timeouts so a lost response re-uses the same idempotent intent.
  const intentRef = useRef<string | null>(null);
  const intent = () => (intentRef.current ??= newIntentId());
  const edited = () => {
    // Rotate only while no send is in flight and nothing is sent or unconfirmed.
    if (!sending && result?.status !== "sent" && result?.status !== "unconfirmed") intentRef.current = null;
  };

  const title: TitleCompany | null = state.titleCompanies.find((t) => t.id === titleId) ?? null;
  const buyer: BuyerEntity | null = state.buyerEntities.find((b) => b.id === buyerId) ?? null;
  const priceCents = parseDollarsToCents(price);
  const earnestCents = parseDollarsToCents(earnest);
  const closingValid = /^\d{4}-\d{2}-\d{2}$/.test(closingDate) && closingDate >= state.tomorrowCentral;

  const prefill = useMemo(
    () =>
      buildContractPrefill({
        ...state.prefillBase,
        settings: { ...state.prefillBase.settings, earnestMoneyCents: earnestCents ?? 0 },
        titleCompany: title,
        buyerEntity: buyer,
        rep: { priceCents: priceCents ?? 0, closingDate: closingValid ? closingDate : "", overrides },
        todayCentral: state.todayCentral,
      }),
    [state, earnestCents, title, buyer, priceCents, closingDate, closingValid, overrides],
  );
  const signers = signersFor(state, buyer);
  const signersOk = signers.every((s) => s.name.trim() && s.emailAddress.trim());

  const noTitle = state.titleCompanies.length === 0;
  const noBuyer = state.buyerEntities.length === 0;
  const unsourced = prefill.missing.filter((n) =>
    !(ECONOMIC_FIELDS as readonly string[]).includes(n) && !["seller_name", "legal_description", "buyer_name", "earnest_money_holder"].includes(n),
  );
  const locked = result?.status === "sent" || result?.status === "unconfirmed";
  const complete = !prefill.blocked && priceCents !== null && priceCents > 0 && earnestCents !== null && signersOk && !!title && !!buyer;
  const disabled = !complete || sending || locked;

  let message: string | null = null;
  if (noTitle) message = "Add a title company in Settings.";
  else if (noBuyer) message = "Add a buyer entity in Settings.";
  else if (!signersOk && buyer) message = "The buyer entity needs an email for the buyer signer.";

  const doSend = async () => {
    if (disabled || priceCents === null || earnestCents === null) return;
    setSending(true);
    try {
      const res = await send({
        propertyId, templateId: state.templateId, sendIntentId: intent(), priceCents, closingDate,
        titleCompanyId: titleId, buyerEntityId: buyerId, earnestMoneyCents: earnestCents, signers, overrides,
      });
      setResult(res);
      // Rotate only when nothing was sent and the server released the intent (blocked, or a definitive
      // failure). Every other result keeps the id so a retry replays the durable outcome.
      if (res.status === "blocked" || (res.status === "failed" && res.definitive === true)) intentRef.current = null;
      if (res.status === "sent") onSent?.();
    } catch {
      // A lost response keeps the SAME intent id so a retry replays the durable result.
      setResult({ status: "failed", message: "The response was lost. Check the lead before sending again." });
    } finally {
      setSending(false);
    }
  };

  const status =
    result?.status === "unconfirmed"
      ? "Send unconfirmed. Sandra is checking with Dropbox Sign. Do not send again."
      : result?.status === "sent"
        ? result.offer === "logged"
          ? "Contract sent. Offer logged."
          : result.offer === "conflict"
            ? "Contract sent, offer needs reconciling"
            : "Contract sent. Logging the offer…"
        : result?.status === "blocked" || result?.status === "failed"
          ? result.message
          : null;

  return (
    <section data-testid="send-contract-card" className="bg-card space-y-3 rounded-lg border p-4">
      <h2 className="text-sm font-semibold">Send contract</h2>
      {state.testMode ? (
        <p className="rounded-md border px-3 py-2 text-xs" data-testid="contract-test-mode">
          Dropbox Sign is in test mode. This document is watermarked and not legally binding.
        </p>
      ) : (
        <p className="border-destructive/30 rounded-md border px-3 py-2 text-xs" data-testid="contract-live-mode">
          Dropbox Sign is in live mode. This live request is legally binding and counts against Dropbox Sign billing.
        </p>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-xs">Price
          <input data-testid="contract-price" className={input} inputMode="decimal" value={price} disabled={locked}
            onChange={(e) => { edited(); setPrice(e.target.value); onPriceChange?.(e.target.value); }} />
        </label>
        <label className="text-xs">Closing date
          <input data-testid="contract-closing-date" className={input} type="date" min={state.tomorrowCentral} value={closingDate} disabled={locked}
            onChange={(e) => { edited(); setClosingDate(e.target.value); onClosingDateChange?.(e.target.value); }} />
        </label>
        <label className="text-xs">Title company
          <select data-testid="contract-title-company" className={input} value={titleId} disabled={locked || noTitle}
            onChange={(e) => { edited(); setTitleId(e.target.value); }}>
            <option value="">Choose…</option>
            {state.titleCompanies.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
        <label className="text-xs">Buyer entity
          <select data-testid="contract-buyer-entity" className={input} value={buyerId} disabled={locked || noBuyer}
            onChange={(e) => { edited(); setBuyerId(e.target.value); }}>
            <option value="">Choose…</option>
            {state.buyerEntities.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </label>
        <label className="text-xs">Earnest money
          <input data-testid="contract-earnest" className={input} inputMode="decimal" value={earnest} disabled={locked}
            onChange={(e) => { edited(); setEarnest(e.target.value); }} />
        </label>
      </div>

      {unsourced.length > 0 ? (
        <details data-testid="contract-more-fields">
          <summary className="cursor-pointer text-xs">More fields ({unsourced.length} needed)</summary>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {unsourced.map((name) => (
              <label key={name} className="text-xs">{name.replace(/_/g, " ")}
                <input className={input} value={overrides[name] ?? ""} disabled={locked}
                  onChange={(e) => { edited(); setOverrides((o) => ({ ...o, [name]: e.target.value })); }} />
              </label>
            ))}
          </div>
        </details>
      ) : null}

      <dl data-testid="contract-review-line" className="space-y-1 rounded-md border p-2 text-xs">
        <div><dt className="inline font-medium">Seller: </dt><dd className="inline">{prefill.review.sellerNames || needed}</dd></div>
        <div><dt className="inline font-medium">Legal description: </dt><dd className="inline">{prefill.review.legalDescription ?? needed}</dd></div>
        <div><dt className="inline font-medium">Price: </dt><dd className="inline">{priceCents ? prefill.review.price : needed}</dd></div>
        <div><dt className="inline font-medium">Closing date: </dt><dd className="inline">{closingValid ? prefill.review.closingDate : needed}</dd></div>
        {prefill.review.ownerOfRecordWarning ? <p className="text-destructive" data-testid="contract-owner-warning">{prefill.review.ownerOfRecordWarning}</p> : null}
      </dl>

      {message ? <p data-testid="contract-blocked" className="text-muted-foreground text-xs">{message}</p> : null}
      {status ? <p role="status" data-testid="contract-status" className="text-xs">{status}</p> : null}

      {result?.status === "unconfirmed" ? null : (
        <Button type="button" data-testid="contract-send" disabled={disabled} onClick={doSend}>
          {sending ? "Sending…" : "Send contract"}
        </Button>
      )}
    </section>
  );
}
