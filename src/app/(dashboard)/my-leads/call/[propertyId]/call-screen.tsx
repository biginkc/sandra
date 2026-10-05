"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { loadMyLeadQueueRow } from "@/app/(dashboard)/my-leads/actions";
import { PostCallPrompt, ReceiptLines } from "@/app/(dashboard)/my-leads/_components/post-call-prompt";
import { listExtrasFor } from "@/app/(dashboard)/my-leads/_components/extras-store";
import { extrasConfirmed, saveExtrasRequest, type ExtrasRequest } from "@/app/(dashboard)/my-leads/_components/extras-saver";
import type { PostCallExtrasState } from "@/app/(dashboard)/my-leads/_components/types";
import { useAttemptWorkflow, type AttemptOpening } from "@/app/(dashboard)/my-leads/_components/use-attempt-workflow";
import { DialStatus } from "@/app/(dashboard)/my-leads/_components/dial-status";
import { useApiDial } from "@/app/(dashboard)/my-leads/_components/use-api-dial";
import { WorkflowRecoveryContext } from "@/app/(dashboard)/my-leads/_components/workflow-form";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";

import { compLeadAction, setValuationInputsAction } from "./actions";
import { sendContractCardAction } from "./contract-card/contract-card-actions";
import { ContractCard } from "./contract-card/contract-card";
import { HistoryPanel } from "./history-panel";
import { NumbersCard } from "./numbers-card";
import { StaticScriptView } from "./static-script-view";
import type { CallScreenData } from "./types";

export type CallScreenProps = {
  data: CallScreenData;
  viewerLabel?: string | null;
  /** `click_to_dial` flag AND `schemaReady('api_dial')`, resolved on the server (getMyLeadsCallFeatures). Off keeps Call disabled. */
  clickToDial?: boolean;
};

const STAGE_LABEL: Record<string, string> = {
  not_contacted: "Not contacted",
  contacted: "Contacted",
  needs_offer: "Needs offer",
  offer_sent: "Offer sent",
  under_contract: "Under contract",
};

/**
 * D7 layout. ≥1024px: left 60% static script in its own scroll container; right 40% stacked
 * numbers → (contract, hidden in 3b) → history → docked post-call prompt. Below: single column
 * header, numbers, script, history, prompt. The contract and facts slots are omitted here.
 */
export function CallScreen({ data, viewerLabel = null, clickToDial = false }: CallScreenProps) {
  const router = useRouter();
  const { lead, queueRow, viewer } = data;
  const propertyId = lead.propertyId;
  const title = lead.homeowner.name || lead.address;
  const addressLine = [lead.address, lead.city, lead.state, lead.zip].filter(Boolean).join(", ");

  // Entry chips in the script and the (future) card price/date share this one state.
  const [entryFields, setEntryFields] = useState<Record<string, string | null>>(() => ({
    motivation: queueRow.motivationKind === "specified" ? queueRow.motivationText : null,
  }));
  const onEntryFieldChange = useCallback((token: string, value: string) => {
    setEntryFields((prev) => ({ ...prev, [token]: value.trim() === "" ? null : value }));
  }, []);

  // The same dial path (and per-lead key lifecycle) as the My Leads page.
  const { dialFlight, dialActive, startApiDial, statusHandlers } = useApiDial((id) =>
    id === propertyId ? { contactId: lead.homeowner.contactId, label: title } : null,
  );
  const canDial = clickToDial && !!lead.homeowner.contactId && lead.homeowner.phones.length > 0 && !queueRow.contactDnc && !dialActive;
  const onCall = () => {
    if (!canDial) return;
    void startApiDial(propertyId, 1);
  };

  // Post-call prompt (P1c) docked; the attempt workflow core is the same one the queue uses.
  // The opening's identity is its idempotency key, so key it on the lead + queue version only. A
  // refresh (e.g. after a valuation save) hands back a new queueRow object at the same version; that
  // must not mint a new opening and a second attempt key. The row is read at the version's first render.
  const queueVersion = queueRow.queueVersion;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const opening = useMemo<AttemptOpening>(() => ({ action: "log-attempt", row: queueRow }), [propertyId, queueVersion]);
  const [extrasState, setExtrasState] = useState<PostCallExtrasState | null>(null);
  const extrasRequest = useRef<ExtrasRequest | null>(null);
  const extrasInFlight = useRef(new Set<string>());
  const openingRef = useRef(opening);
  useEffect(() => {
    openingRef.current = opening;
  });

  // The shared P1c saver (also behind the My Leads page): idempotent per extra, and the stored
  // entry is cleared only after the server confirms both. `show` is false for a replay that belongs
  // to an earlier opening, which must not take over the current prompt's status line.
  const runExtras = async (request: ExtrasRequest, show: boolean) => {
    const result = await saveExtrasRequest(request, viewer.userId, extrasInFlight.current, () => {
      if (show) {
        extrasRequest.current = request;
        setExtrasState({ status: "saving" });
      }
    });
    if (!result) return;
    if (show && extrasRequest.current === request) setExtrasState({ status: "done", result });
    if (result.ok) router.refresh();
  };

  // After a reload the stored entry of an earlier attempt on this lead (a failed or interrupted
  // save) is surfaced here with a Retry, through the same saver. The live page keeps such an entry
  // for its recovery paths; this screen has no recovery record after a reload, so it offers Retry.
  const [recovered, setRecovered] = useState<ExtrasRequest | null>(null);
  const [recoveredState, setRecoveredState] = useState<PostCallExtrasState | null>(null);
  useEffect(() => {
    const entry = listExtrasFor(viewer.userId, propertyId)[0];
    // Reads sessionStorage, which only exists on the client, once per lead.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRecovered(entry ? { attemptKey: entry.attemptKey, memberId: entry.memberId, propertyId: entry.propertyId, extras: entry.extras } : null);
    setRecoveredState(entry ? { status: "done", result: { ok: false, message: "A note or next step from an earlier call on this lead was not saved." } } : null);
  }, [viewer.userId, propertyId]);
  const retryRecovered = async () => {
    if (!recovered) return;
    const result = await saveExtrasRequest(recovered, viewer.userId, extrasInFlight.current, () => setRecoveredState({ status: "saving" }));
    if (!result) return;
    if (extrasConfirmed(result)) {
      setRecovered(null);
      setRecoveredState(null);
    } else {
      setRecoveredState({ status: "done", result });
    }
    if (result.ok) router.refresh();
  };

  const { submit, recoveryValue, onDripChanged } = useAttemptWorkflow<AttemptOpening>({
    opening,
    memberId: viewer.userId,
    viewer: { userId: viewer.userId, orgId: viewer.orgId },
    readRow: async (current) => {
      const read = await loadMyLeadQueueRow({ memberId: viewer.userId, propertyId: current.row.propertyId });
      if (!read.ok) throw new Error(read.message);
      return read.lookup.status === "found" ? read.lookup.row : null;
    },
    onCommitted: async (committed) => {
      if (committed.extras) {
        void runExtras(
          { attemptKey: committed.attemptKey, memberId: viewer.userId, propertyId, extras: committed.extras },
          true,
        );
      }
      router.refresh();
    },
    // Recovery paths (late success, already saved, reconciliation): the note must still be written.
    onExtras: (flush) => {
      void runExtras(
        { attemptKey: flush.attemptKey, memberId: flush.memberId, propertyId: flush.propertyId, extras: flush.extras },
        flush.opening === openingRef.current,
      );
    },
    onSettled: () => undefined,
    onClose: () => router.refresh(),
    onDripChanged: () => router.refresh(),
  });

  const numbers = (
    <NumbersCard
      propertyId={propertyId}
      comps={data.comps}
      isTraining={lead.isTraining}
      onSaveValuation={async (input) => {
        const result = await setValuationInputsAction({ propertyId, ...input });
        if (result.ok) router.refresh();
        return result;
      }}
      onCompLead={() => compLeadAction(propertyId)}
      onCompsChanged={() => router.refresh()}
    />
  );
  const script = <StaticScriptView script={data.script} entryFields={entryFields} onEntryFieldChange={onEntryFieldChange} />;
  const history = (
    <HistoryPanel propertyId={propertyId} contactId={lead.homeowner.contactId} viewerUserId={viewer.userId} notes={data.notes} messages={data.messages} />
  );
  const recoveredBanner = recovered ? (
    <div data-testid="call-screen-recovered-extras" className="rounded-[16px] border border-border bg-card p-4">
      <ReceiptLines extras={recoveredState} sentNextStepAt={null} note={recovered.extras.note} onRetry={() => void retryRecovered()} />
    </div>
  ) : null;
  const prompt = (
    <WorkflowRecoveryContext.Provider value={recoveryValue}>
      <PostCallPrompt
        variant="dock"
        open
        propertyId={propertyId}
        propertyLabel={lead.address}
        onOpenChange={() => undefined}
        onSubmit={(payload) => submit(payload)}
        onDripChanged={onDripChanged}
        viewerUserId={viewer.userId}
        viewerLabel={viewerLabel}
        nextStepAt={queueRow.nextStepAt}
        extras={extrasState}
        onRetryExtras={() => {
          const request = extrasRequest.current;
          if (request) void runExtras(request, true);
        }}
      />
    </WorkflowRecoveryContext.Provider>
  );

  return (
    <div data-testid="call-screen" className="flex min-h-0 flex-1 flex-col gap-4">
      <header data-testid="call-screen-header" className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <h1 className="truncate text-xl font-bold">{title}</h1>
          <p className="text-muted-foreground truncate text-sm">{addressLine}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" data-testid="call-screen-stage">{STAGE_LABEL[queueRow.stage] ?? queueRow.stage}</Badge>
          <Button
            type="button"
            data-testid={`call-button-${propertyId}`}
            disabled={!canDial}
            onClick={onCall}
          >
            Call
          </Button>
          <Link href="/my-leads" className={buttonVariants({ variant: "outline" })}>
            Back to My Leads
          </Link>
        </div>
        {clickToDial ? (
          <div className="w-full">
            <DialStatus
              flight={dialFlight}
              {...statusHandlers}
              onEnded={() => router.refresh()}
            />
          </div>
        ) : null}
      </header>

      {/* ≥1024px: two columns. Below: single column in the D7 order. */}
      <div data-testid="call-screen-columns" className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[3fr_2fr]">
        <div data-testid="call-screen-left" className="order-2 min-h-0 lg:order-1 lg:max-h-[calc(100dvh-10rem)] lg:overflow-y-auto">
          {script}
        </div>
        <div data-testid="call-screen-right" className="order-1 flex min-h-0 flex-col gap-4 lg:order-2">
          <div className="contents lg:flex lg:flex-col lg:gap-4">
            {numbers}
            {data.contract.ok && data.contract.data.enabled ? (
              <div className="order-2 lg:order-none">
                <ContractCard
                  state={data.contract.data}
                  propertyId={propertyId}
                  send={sendContractCardAction}
                  onPriceChange={(v) => onEntryFieldChange("offer_price", v)}
                  onClosingDateChange={(v) => onEntryFieldChange("closing_date", v)}
                  onSent={() => router.refresh()}
                />
              </div>
            ) : null}
            <div className="order-3 lg:order-none">{history}</div>
            <div data-testid="call-screen-prompt-dock" className="order-4 flex flex-col gap-3 lg:sticky lg:bottom-0 lg:order-none">{recoveredBanner}{prompt}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
