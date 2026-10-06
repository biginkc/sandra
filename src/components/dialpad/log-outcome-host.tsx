"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import { loadMyLeadQueueRow } from "@/app/(dashboard)/my-leads/actions";
import { PostCallPrompt } from "@/app/(dashboard)/my-leads/_components/post-call-prompt";
import { saveExtrasRequest, type ExtrasRequest } from "@/app/(dashboard)/my-leads/_components/extras-saver";
import type { PostCallExtrasState } from "@/app/(dashboard)/my-leads/_components/types";
import { useAttemptWorkflow, type AttemptOpening } from "@/app/(dashboard)/my-leads/_components/use-attempt-workflow";
import { WorkflowRecoveryContext } from "@/app/(dashboard)/my-leads/_components/workflow-form";
import { Button } from "@/components/ui/button";

export type LoggingViewer = { userId: string; orgId: string; label: string | null };
export type LogOutcomeRequest = { propertyId: string; callActivityId: string };

/**
 * "Log outcome" for a Sandra-placed call, opened right where the rep is (Messages, a lead's page, any
 * dashboard page) with no navigation. It is the same bound prompt and the same attempt workflow as My
 * Leads and the call screen: the call's own pending attempt is finalized, never a second one.
 */
export function LogOutcomeHost({
  viewer,
  request,
  onClose,
  onLogged,
}: {
  viewer: LoggingViewer;
  request: LogOutcomeRequest | null;
  onClose: () => void;
  onLogged: (callActivityId: string) => void;
}) {
  const [loaded, setLoaded] = useState<{ key: string; opening: AttemptOpening | null; error: string | null } | null>(null);
  const requestKey = request ? `${request.propertyId}:${request.callActivityId}` : null;

  useEffect(() => {
    if (!request || !requestKey) return;
    let alive = true;
    void loadMyLeadQueueRow({ memberId: viewer.userId, propertyId: request.propertyId }).then(
      (read) => {
        if (!alive) return;
        if (read.ok && read.lookup.status === "found") {
          setLoaded({ key: requestKey, opening: { action: "log-attempt", row: read.lookup.row, callActivityId: request.callActivityId }, error: null });
        } else {
          setLoaded({
            key: requestKey,
            opening: null,
            error: read.ok ? "This lead is not in your My Leads queue, so its call cannot be logged here." : read.message,
          });
        }
      },
      () => {
        if (alive) setLoaded({ key: requestKey, opening: null, error: "Could not load this lead. Please retry." });
      },
    );
    return () => {
      alive = false;
    };
  }, [request, requestKey, viewer.userId]);

  const current = loaded && loaded.key === requestKey ? loaded : null;
  if (!request || !requestKey) return null;
  if (!current) return null;
  if (!current.opening) {
    return (
      <div role="alert" data-testid="log-outcome-error" className="bg-card fixed bottom-20 left-4 z-50 flex max-w-[calc(100vw-2rem)] flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2 text-sm md:left-72">
        <span>{current.error}</span>
        <Link href={`/my-leads?lead=${request.propertyId}`} className="font-bold underline underline-offset-4">Open My Leads</Link>
        <Button type="button" variant="outline" size="sm" onClick={onClose}>Close</Button>
      </div>
    );
  }
  return <LogOutcomeDialog key={requestKey} viewer={viewer} opening={current.opening} onClose={onClose} onLogged={onLogged} />;
}

function LogOutcomeDialog({
  viewer,
  opening: initial,
  onClose,
  onLogged,
}: {
  viewer: LoggingViewer;
  opening: AttemptOpening;
  onClose: () => void;
  onLogged: (callActivityId: string) => void;
}) {
  // One object per opening: its identity is the attempt's idempotency key.
  const opening = useMemo(() => initial, [initial]);
  const propertyId = opening.row.propertyId;
  const [extrasState, setExtrasState] = useState<PostCallExtrasState | null>(null);
  const extrasRequest = useRef<ExtrasRequest | null>(null);
  const extrasInFlight = useRef(new Set<string>());
  const openingRef = useRef(opening);
  useEffect(() => {
    openingRef.current = opening;
  });
  const runExtras = async (req: ExtrasRequest, show: boolean) => {
    const result = await saveExtrasRequest(req, viewer.userId, extrasInFlight.current, () => {
      if (show) {
        extrasRequest.current = req;
        setExtrasState({ status: "saving" });
      }
    });
    if (!result) return;
    if (show && extrasRequest.current === req) setExtrasState({ status: "done", result });
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
      if (opening.callActivityId) onLogged(opening.callActivityId);
      if (committed.extras) {
        void runExtras({ attemptKey: committed.attemptKey, memberId: viewer.userId, propertyId, extras: committed.extras }, true);
      }
    },
    onExtras: (flush) => {
      void runExtras(
        { attemptKey: flush.attemptKey, memberId: flush.memberId, propertyId: flush.propertyId, extras: flush.extras },
        flush.opening === openingRef.current,
      );
    },
    onSettled: () => undefined,
    onClose: () => onClose(),
    onDripChanged: () => undefined,
  });
  return (
    <WorkflowRecoveryContext.Provider value={recoveryValue}>
      <PostCallPrompt
        open
        propertyId={propertyId}
        propertyLabel={opening.row.address}
        initialCallActivityId={opening.callActivityId ?? null}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        onSubmit={(payload) => submit(payload)}
        onDripChanged={onDripChanged}
        viewerUserId={viewer.userId}
        viewerLabel={viewer.label}
        nextStepAt={opening.row.nextStepAt}
        extras={extrasState}
        onRetryExtras={() => {
          const req = extrasRequest.current;
          if (req) void runExtras(req, true);
        }}
      />
    </WorkflowRecoveryContext.Provider>
  );
}
