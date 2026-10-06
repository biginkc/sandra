"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { loadMyLeadQueueRow } from "@/app/(dashboard)/my-leads/actions";
import { PostCallPrompt, ReceiptLines, type PromptOutcome } from "@/app/(dashboard)/my-leads/_components/post-call-prompt";
import { listExtrasFor } from "@/app/(dashboard)/my-leads/_components/extras-store";
import { extrasConfirmed, saveExtrasRequest, type ExtrasRequest } from "@/app/(dashboard)/my-leads/_components/extras-saver";
import type { PostCallExtrasState } from "@/app/(dashboard)/my-leads/_components/types";
import { useAttemptWorkflow, type AttemptOpening } from "@/app/(dashboard)/my-leads/_components/use-attempt-workflow";
import { useOptionalDialpadCall, type DialpadEndedCall } from "@/components/dialpad/dialpad-call-context";
import { WorkflowRecoveryContext } from "@/app/(dashboard)/my-leads/_components/workflow-form";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";

import { CallFactChips } from "./call-fact-chips";
import { acceptCallFactAction, dismissCallFactsAction } from "./facts-actions";
import { compLeadAction, setValuationInputsAction } from "./actions";
import {
  cancelContractAction, reassignAndLogOfferAction, retryOfferProjectionAction, sendContractCardAction, supersedeOfferAction,
} from "./contract-card/contract-card-actions";

const RECOVERY_ACTIONS = {
  retry: retryOfferProjectionAction,
  supersede: supersedeOfferAction,
  reassign: reassignAndLogOfferAction,
  cancel: cancelContractAction,
};
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
  /** `post_call_prompt` flag (and its schema), resolved on the server. The post-call prompt needs this AND `call_screen`. */
  postCallPrompt?: boolean;
};

type PendingCall = { callActivityId: string; endedAt: string | null; talkSeconds: number | null; outcomeGuess: PromptOutcome | null };

const STAGE_LABEL: Record<string, string> = {
  not_contacted: "Not contacted",
  contacted: "Contacted",
  needs_offer: "Needs offer",
  offer_sent: "Offer sent",
  under_contract: "Under contract",
};

/**
 * D7 layout. ≥1024px: left 60% static script in its own scroll container; right 40% stacked
 * numbers → facts → contract → history. Below: single column header, numbers, script, history. The
 * post-call prompt is ONE prompt tied to the call that just ended: it appears at the top of the script
 * column (never over the numbers or the contract card), and only after hangup while that call has no
 * outcome. Call facts chips sit under the numbers when a proposal is open.
 */
export function CallScreen({ data, viewerLabel = null, clickToDial = false, postCallPrompt = false }: CallScreenProps) {
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
  // The flight and its lock are owned by the persistent layout provider.
  const dialpadCall = useOptionalDialpadCall();
  const dialActive = dialpadCall?.dialActive ?? false;
  const canDial = clickToDial && !!lead.homeowner.contactId && lead.homeowner.phones.length > 0 && !queueRow.contactDnc && !dialActive;
  const onCall = () => {
    if (!canDial) return;
    if (!lead.homeowner.contactId) return;
    dialpadCall?.startCall({ propertyId, contactId: lead.homeowner.contactId, label: title });
  };

  // The one call this screen's prompt is for: seeded from the server's pending attempt (a reload, or
  // arriving after hangup) and set when this lead's call ends. Null means no prompt at all.
  const [pendingCall, setPendingCall] = useState<PendingCall | null>(() =>
    data.pendingCall
      ? { callActivityId: data.pendingCall.callActivityId, endedAt: data.pendingCall.endedAt, talkSeconds: data.pendingCall.talkDurationSeconds ?? data.pendingCall.durationSeconds, outcomeGuess: data.pendingCall.outcomeGuess }
      : null,
  );
  const [scriptOpen, setScriptOpen] = useState(false);
  const loggedIds = dialpadCall?.loggedCallActivityIds;
  // After a save here the prompt stays as a receipt (drip choice, note status) until Done. A call logged
  // anywhere else is never prompted again.
  const [savedHere, setSavedHere] = useState<string | null>(null);
  const showPrompt = postCallPrompt && pendingCall !== null && (savedHere === pendingCall.callActivityId || !loggedIds?.has(pendingCall.callActivityId));
  const pendingCallId = pendingCall?.callActivityId ?? null;
  const showingFor = showPrompt ? pendingCallId : null;
  const registerPageHandlers = dialpadCall?.registerPageHandlers;
  const openLogOutcome = dialpadCall?.openLogOutcome;
  const onEndedRef = useRef<(info?: DialpadEndedCall) => void>(() => undefined);
  const onLogOutcomeRef = useRef<(forProperty: string, callActivityId: string) => void>(() => undefined);
  useEffect(() => {
    onEndedRef.current = (info) => {
      if (!info || info.propertyId !== propertyId) return;
      setPendingCall((current) =>
        current?.callActivityId === info.callActivityId ? current : { callActivityId: info.callActivityId, endedAt: info.endedAt, talkSeconds: info.talkSeconds, outcomeGuess: null },
      );
    };
    onLogOutcomeRef.current = (forProperty, callActivityId) => {
      if (forProperty === propertyId) setPendingCall((current) => (current?.callActivityId === callActivityId ? current : { callActivityId, endedAt: null, talkSeconds: null, outcomeGuess: null }));
      else openLogOutcome?.(forProperty, callActivityId);
    };
  });
  useEffect(() => {
    if (!registerPageHandlers) return;
    return registerPageHandlers({
      onEnded: (info) => onEndedRef.current(info),
      onLogOutcome: (forProperty, callActivityId) => onLogOutcomeRef.current(forProperty, callActivityId),
      showingPromptFor: showingFor,
    });
  }, [registerPageHandlers, showingFor]);

  // Post-call prompt (P1c); the attempt workflow core is the same one the queue uses.
  // The opening's identity is its idempotency key, so key it on the lead + queue version + call only. A
  // refresh (e.g. after a valuation save) hands back a new queueRow object at the same version; that
  // must not mint a new opening and a second attempt key. The row is read at the version's first render.
  const queueVersion = queueRow.queueVersion;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const opening = useMemo<AttemptOpening>(() => ({ action: "log-attempt", row: queueRow, callActivityId: pendingCallId }), [propertyId, queueVersion, pendingCallId]);
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
    // Confirmed, or another prompt already saved this call (the saver dropped the entry): no banner, no Retry.
    if (extrasConfirmed(result) || (!result.ok && result.alreadySaved)) {
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
      // This call's outcome is saved: its panel (and any reminder) is done, and no second prompt can open for it.
      if (committed.opening.callActivityId) {
        setSavedHere(committed.opening.callActivityId);
        dialpadCall?.clearEndedCall?.(committed.opening.callActivityId);
      }
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
      <ReceiptLines extras={recoveredState} sentNextStepAt={null} note={recovered.extras.note} attemptSaved={false} onRetry={() => void retryRecovered()} />
    </div>
  ) : null;
  const prompt = pendingCall ? (
    <WorkflowRecoveryContext.Provider value={recoveryValue}>
      <PostCallPrompt
        key={pendingCall.callActivityId}
        variant="dock"
        open
        propertyId={propertyId}
        propertyLabel={lead.address}
        initialCallActivityId={pendingCall.callActivityId}
        initialOutcome={pendingCall.outcomeGuess}
        boundCall={{ endedAt: pendingCall.endedAt, talkSeconds: pendingCall.talkSeconds }}
        // Done (after a save) closes the receipt; nothing else can close it, so an unsaved call stays prompted.
        onOpenChange={(open) => {
          if (!open) setPendingCall(null);
        }}
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
  ) : null;

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
      </header>

      {/* ≥1024px: two columns. Below: single column in the D7 order. */}
      <div data-testid="call-screen-columns" className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[3fr_2fr]">
        <div data-testid="call-screen-left" className="order-2 flex min-h-0 flex-col gap-4 lg:order-1 lg:max-h-[calc(100dvh-10rem)] lg:overflow-y-auto">
          {postCallPrompt ? recoveredBanner : null}
          {showPrompt ? prompt : null}
          {showPrompt && !scriptOpen ? (
            <Button type="button" variant="outline" data-testid="call-screen-show-script" className="self-start" onClick={() => setScriptOpen(true)}>
              Show script
            </Button>
          ) : (
            script
          )}
        </div>
        <div data-testid="call-screen-right" className="order-1 flex min-h-0 flex-col gap-4 lg:order-2">
          <div className="contents lg:flex lg:flex-col lg:gap-4">
            {numbers}
            {data.facts.ok && data.facts.data ? (
              <div className="order-1 lg:order-none">
                <CallFactChips
                  key={data.facts.data.factId}
                  facts={data.facts.data}
                  onAccept={(field) => acceptCallFactAction({ propertyId, factId: data.facts.ok && data.facts.data ? data.facts.data.factId : "", field })}
                  onDismiss={() => dismissCallFactsAction({ propertyId, factId: data.facts.ok && data.facts.data ? data.facts.data.factId : "" })}
                  // Motivation prefills only the shared entry field (script chip); nothing is written to the lead here.
                  onAccepted={(field, value) => {
                    if (field === "motivation") onEntryFieldChange("motivation", value);
                    router.refresh();
                  }}
                />
              </div>
            ) : null}
            {data.contract.ok && data.contract.data.enabled ? (
              <div className="order-2 lg:order-none">
                <ContractCard
                  state={data.contract.data}
                  propertyId={propertyId}
                  send={sendContractCardAction}
                  recovery={RECOVERY_ACTIONS}
                  onRefresh={() => router.refresh()}
                  onPriceChange={(v) => onEntryFieldChange("offer_price", v)}
                  onClosingDateChange={(v) => onEntryFieldChange("closing_date", v)}
                  onSent={() => router.refresh()}
                />
              </div>
            ) : null}
            <div className="order-3 lg:order-none">{history}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
