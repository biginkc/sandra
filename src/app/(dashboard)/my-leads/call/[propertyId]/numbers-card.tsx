"use client";

import { useState } from "react";

import { ProviderDataView } from "@/components/leads/provider-data-view";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDollars } from "@/lib/calculators/closr-v1";
import {
  AS_IS_ANCHOR_KEYS,
  ARV_ANCHOR_KEYS,
  computeAnchors,
  type AnchorValue,
} from "@/lib/comps/anchors";
import type { CompLeadResult } from "@/lib/comps/types";

import type { CompLeadActionResult } from "./actions";
import type { CallScreenComps, Section } from "./types";

export type NumbersCardProps = {
  propertyId: string;
  comps: Section<CallScreenComps>;
  isTraining: boolean;
  onSaveValuation?: (input: { arv: number | null; rehab: number | null }) => Promise<{ ok: true } | { ok: false; message: string }>;
  onCompLead?: () => Promise<CompLeadActionResult>;
  onCompsChanged?: () => void;
};

const ANCHOR_LABELS: Record<string, string> = {
  equity: "Equity",
  family: "Family",
  secure: "Secure",
  rapid: "Rapid",
  arv70: "ARV 70%",
  investor: "Investor",
  fee40000: "Fee $40,000",
  fee30000: "Fee $30,000",
  fee20000: "Fee $20,000",
  fee10000: "Fee $10,000",
};

function anchorText(a: AnchorValue): string {
  return a.status === "ok" ? formatDollars(a.value) : "unavailable";
}

export function compLeadMessage(result: CompLeadResult): string | null {
  switch (result.status) {
    case "ready":
      return "Comps updated";
    case "pending":
      return "comps pending";
    case "capped":
      return "Monthly comp cap reached";
    case "disabled":
      return "Comps disabled";
    case "no_match":
      return "No matching property found";
    case "unavailable":
      return result.reason === "training_lead"
        ? "Comps are not fetched for training leads"
        : result.reason === "missing_address"
          ? "This lead has no address to comp"
          : "Property not found";
    case "error":
      return result.code === "BACKOFF"
        ? "Comps paused after a recent provider error. Try again later."
        : `Comps request failed (${result.code})`;
  }
}

function requestMessage(status: string): string | null {
  switch (status) {
    case "no_match":
      return "No matching property found";
    case "error":
      return "Last comp fetch failed";
    case "capped":
      return "Monthly comp cap reached";
    case "cancelled":
      return "Comp request cancelled";
    default:
      return null;
  }
}

function parseAmount(raw: string): { ok: true; value: number | null } | { ok: false } {
  const trimmed = raw.trim().replace(/[$,]/g, "");
  if (trimmed === "") return { ok: true, value: null };
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return { ok: false };
  return { ok: true, value: n };
}

export function NumbersCard({ propertyId, comps, isTraining, onSaveValuation, onCompLead, onCompsChanged }: NumbersCardProps) {
  const [arvInput, setArvInput] = useState(comps.ok && comps.data.valuation.arv != null ? String(comps.data.valuation.arv) : "");
  const [rehabInput, setRehabInput] = useState(comps.ok && comps.data.valuation.rehab != null ? String(comps.data.valuation.rehab) : "");
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [compBusy, setCompBusy] = useState(false);
  const [compMessage, setCompMessage] = useState<string | null>(null);

  if (!comps.ok) {
    return (
      <Card data-testid="numbers-card" className="flex flex-col gap-2 p-4">
        <h2 className="text-sm font-semibold">Numbers unavailable</h2>
        <p className="text-muted-foreground text-sm">{comps.message}</p>
      </Card>
    );
  }

  const { latest, request, settings, valuation } = comps.data;
  const effectiveArv = valuation.arv ?? latest?.arv_estimate ?? null;
  const anchors = computeAnchors({
    asIs: latest?.as_is_value ?? null,
    arv: effectiveArv,
    rehab: valuation.rehab,
    verifyFirst: latest?.verify_first ?? true,
  });
  const allArvUnavailable = ARV_ANCHOR_KEYS.every((k) => anchors.arvDependent[k].status !== "ok");
  const showArvInput = !latest || latest.arv_method === "none";
  const pending = request?.status === "queued" || request?.status === "running";
  const requestNote = request ? requestMessage(request.status) : null;
  const topComps = latest
    ? [...latest.comps]
        .sort((a, b) => {
          const d = b.saleDate.localeCompare(a.saleDate);
          if (d !== 0) return d;
          return (a.distanceMiles ?? Infinity) - (b.distanceMiles ?? Infinity);
        })
        .slice(0, 6)
    : [];

  const compDisabledLabel = isTraining ? null : !settings.enabled ? "Comps disabled" : settings.capped ? "Monthly comp cap reached" : null;
  const compDisabled = isTraining || !settings.enabled || settings.capped || !onCompLead || compBusy;

  async function save() {
    if (!onSaveValuation) return;
    const arv = showArvInput ? parseAmount(arvInput) : { ok: true as const, value: valuation.arv };
    const rehab = parseAmount(rehabInput);
    if (!arv.ok || !rehab.ok) {
      setSaveMessage("Enter a number of zero or more.");
      return;
    }
    setSaving(true);
    setSaveMessage(null);
    try {
      const res = await onSaveValuation({ arv: arv.value, rehab: rehab.value });
      if (!res.ok) setSaveMessage(res.message);
    } catch {
      setSaveMessage("Could not save the numbers.");
    } finally {
      setSaving(false);
    }
  }

  async function compLead() {
    if (!onCompLead) return;
    setCompBusy(true);
    setCompMessage(null);
    try {
      const res = await onCompLead();
      if (!res.ok) {
        setCompMessage(res.message);
      } else {
        setCompMessage(compLeadMessage(res.result));
        if (res.result.status === "ready") onCompsChanged?.();
      }
    } catch {
      setCompMessage("Comps request failed");
    } finally {
      setCompBusy(false);
    }
  }

  return (
    <Card data-testid="numbers-card" className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">Numbers</h2>
        {latest?.provider === "fixture" ? (
          <Badge data-testid="numbers-fixture-ribbon" variant="outline">Fixture data</Badge>
        ) : null}
        {latest?.verify_first === true ? (
          <span data-testid="numbers-verify-first" className="rounded-full bg-[var(--coach-amber)] px-2.5 py-0.5 text-[11px] font-bold text-[var(--coach-rail)]">
            Verify first
          </span>
        ) : null}
      </div>
      {latest?.verify_first === true && latest.verify_reasons.length > 0 ? (
        <p className="text-muted-foreground text-xs">{latest.verify_reasons.join(", ")}</p>
      ) : null}

      {latest ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-lg font-bold">
            As-is {latest.as_is_value != null ? formatDollars(latest.as_is_value) : "unavailable"}
          </span>
          {latest.as_is_low != null && latest.as_is_high != null ? (
            <span className="text-muted-foreground text-sm">
              {formatDollars(latest.as_is_low)} – {formatDollars(latest.as_is_high)}
            </span>
          ) : null}
          <Badge variant="secondary">{latest.confidence ?? "no confidence"}</Badge>
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">No comps yet</p>
      )}

      {latest?.provider === "attom" ? <><p className="text-muted-foreground text-xs">ATTOM automated estimate · Fetched {new Date(latest.fetched_at).toLocaleString("en-US", { timeZone: "America/Chicago" })} CT</p><ProviderDataView data={latest.providerData} /></> : null}

      <p className="text-sm">ARV {effectiveArv != null ? formatDollars(effectiveArv) : "unavailable"}</p>

      <div className="grid grid-cols-2 gap-1 text-sm" data-testid="numbers-as-is-anchors">
        {AS_IS_ANCHOR_KEYS.map((key) => (
          <div key={key} className="flex justify-between gap-2">
            <span className="text-muted-foreground">{ANCHOR_LABELS[key]}</span>
            <span>{anchorText(anchors.asIsDependent[key])}</span>
          </div>
        ))}
      </div>

      <div data-testid="numbers-arv-anchors" className="text-sm">
        {allArvUnavailable ? (
          <p className="text-muted-foreground">unavailable: needs ARV and rehab</p>
        ) : (
          <div className="grid grid-cols-2 gap-1">
            {ARV_ANCHOR_KEYS.map((key) => (
              <div key={key} className="flex justify-between gap-2">
                <span className="text-muted-foreground">{ANCHOR_LABELS[key]}</span>
                <span>{anchorText(anchors.arvDependent[key])}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-2">
        {showArvInput ? (
          <div className="flex flex-col gap-1">
            <Label htmlFor={`numbers-arv-${propertyId}`}>ARV</Label>
            <Input id={`numbers-arv-${propertyId}`} data-testid="numbers-arv" inputMode="decimal" value={arvInput} onChange={(e) => setArvInput(e.target.value)} className="w-36" />
          </div>
        ) : null}
        <div className="flex flex-col gap-1">
          <Label htmlFor={`numbers-rehab-${propertyId}`}>Rehab</Label>
          <Input id={`numbers-rehab-${propertyId}`} data-testid="numbers-rehab" inputMode="decimal" value={rehabInput} onChange={(e) => setRehabInput(e.target.value)} className="w-36" />
        </div>
        <Button type="button" size="sm" data-testid="numbers-save" disabled={!onSaveValuation || saving} onClick={save}>
          Save
        </Button>
      </div>
      {saveMessage ? <p role="alert" className="text-destructive text-xs">{saveMessage}</p> : null}

      {latest ? (
        <div className="overflow-x-auto">
          {topComps.length === 0 ? (
            <p className="text-muted-foreground text-sm">No priced comparable sales</p>
          ) : (
            <table className="w-full text-left text-xs" data-testid="numbers-comps-table">
              <thead>
                <tr className="text-muted-foreground">
                  <th className="pr-2 font-medium">Address</th>
                  <th className="pr-2 font-medium">Sale date</th>
                  <th className="pr-2 font-medium">Price</th>
                  <th className="pr-2 font-medium">Sqft</th>
                  <th className="font-medium">Distance</th>
                </tr>
              </thead>
              <tbody>
                {topComps.map((c, i) => (
                  <tr key={`${c.address}-${c.saleDate}-${i}`}>
                    <td className="pr-2">{c.address}</td>
                    <td className="pr-2">{c.saleDate}</td>
                    <td className="pr-2">{formatDollars(c.salePrice)}</td>
                    <td className="pr-2">{c.sqft ?? "-"}</td>
                    <td>{c.distanceMiles != null ? `${c.distanceMiles} mi` : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="text-muted-foreground mt-2 text-xs">Owner of record: {latest.owner_of_record ?? "unknown"}</p>
          <p className="text-muted-foreground text-xs">
            Legal description: {latest.legal_description ?? "unavailable"} ({latest.legal_description_complete ? "complete" : "incomplete"})
          </p>
        </div>
      ) : null}

      {pending ? (
        <div className="flex items-center gap-2">
          <Skeleton className="h-4 w-24" />
          <span className="text-muted-foreground text-sm">comps pending</span>
        </div>
      ) : null}
      {requestNote ? <p className="text-muted-foreground text-xs">{requestNote}</p> : null}

      <div className="flex flex-col gap-1">
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid={`comp-this-lead-${propertyId}`}
          disabled={compDisabled}
          title={isTraining ? "Comps are not fetched for training leads" : undefined}
          onClick={compLead}
        >
          {compDisabledLabel ?? "Comp this lead"}
        </Button>
        {compMessage ? <p role="status" className="text-muted-foreground text-xs">{compMessage}</p> : null}
      </div>
    </Card>
  );
}
