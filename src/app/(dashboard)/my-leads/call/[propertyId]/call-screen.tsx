"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";

import { loadMyLeadQueueRow, savePostCallExtras } from "@/app/(dashboard)/my-leads/actions";
import { PostCallPrompt } from "@/app/(dashboard)/my-leads/_components/post-call-prompt";
import type { PostCallExtrasState } from "@/app/(dashboard)/my-leads/_components/types";
import { useAttemptWorkflow, type AttemptOpening } from "@/app/(dashboard)/my-leads/_components/use-attempt-workflow";
import { WorkflowRecoveryContext } from "@/app/(dashboard)/my-leads/_components/workflow-form";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";

import { compLeadAction, setValuationInputsAction } from "./actions";
import { DIAL_UNAVAILABLE_COPY, dialLeadAction } from "./dial-stub";
import { HistoryPanel } from "./history-panel";
import { NumbersCard } from "./numbers-card";
import { StaticScriptView } from "./static-script-view";
import type { CallScreenData } from "./types";

export type CallScreenProps = { data: CallScreenData; viewerLabel?: string | null };

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
export function CallScreen({ data, viewerLabel = null }: CallScreenProps) {
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

  const [dialNotice, setDialNotice] = useState<string | null>(null);
  const firstSlot = lead.homeowner.phones[0]?.slot ?? null;
  const canDial = dialLeadAction !== null && firstSlot !== null && !queueRow.contactDnc;
  const onCall = async () => {
    if (!dialLeadAction || firstSlot === null) return;
    const result = await dialLeadAction({ propertyId, phoneSlot: firstSlot });
    setDialNotice(result.ok ? null : result.message);
  };

  // Post-call prompt (P1c) docked; the attempt workflow core is the same one the queue uses.
  // The opening's identity is its idempotency key, so key it on the lead + queue version only. A
  // refresh (e.g. after a valuation save) hands back a new queueRow object at the same version; that
  // must not mint a new opening and a second attempt key. The row is read at the version's first render.
  const queueVersion = queueRow.queueVersion;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const opening = useMemo<AttemptOpening>(() => ({ action: "log-attempt", row: queueRow }), [propertyId, queueVersion]);
  const [extrasState, setExtrasState] = useState<PostCallExtrasState | null>(null);
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
        setExtrasState({ status: "saving" });
        try {
          const result = await savePostCallExtras({
            memberId: viewer.userId,
            propertyId,
            submissionId: committed.extras.submissionId,
            note: committed.extras.note,
            nextStep: committed.extras.nextStep,
          });
          setExtrasState({ status: "done", result });
        } catch {
          setExtrasState({ status: "done", result: { ok: false, message: "The note and next step could not be saved." } });
        }
      }
      router.refresh();
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
            title={dialLeadAction === null ? DIAL_UNAVAILABLE_COPY : undefined}
            onClick={onCall}
          >
            Call
          </Button>
          <Link href="/my-leads" className={buttonVariants({ variant: "outline" })}>
            Back to My Leads
          </Link>
        </div>
        {dialLeadAction === null ? (
          <p data-testid="call-dial-unavailable" className="text-muted-foreground w-full text-xs">{DIAL_UNAVAILABLE_COPY}</p>
        ) : dialNotice ? (
          <p role="alert" className="text-destructive w-full text-xs">{dialNotice}</p>
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
            {/* contract card slot: p3-send-card */}
            <div className="order-3 lg:order-none">{history}</div>
            <div data-testid="call-screen-prompt-dock" className="order-4 lg:sticky lg:bottom-0 lg:order-none">{prompt}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
