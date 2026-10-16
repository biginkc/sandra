"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import type { DialpadCallStatus } from "@/lib/dialpad-cti/contracts";
import { useCallLockHolder } from "@/components/calls/call-lock-context";
import { DialStatus } from "@/app/(dashboard)/my-leads/_components/dial-status";
import { useApiDial } from "@/app/(dashboard)/my-leads/_components/use-api-dial";
import { Button } from "@/components/ui/button";
import { DialpadCallContext, type DialpadCallContextValue, type DialpadCallRequest, type DialpadPageHandlers } from "./dialpad-call-context";

/**
 * The single owner of every Dialpad flight and its call lock. It lives in the dashboard layout, so
 * navigating between pages never unmounts it. Lead buttons, Messages, My Leads and the call screen
 * call `startCall` and read its state; none of them runs a dial of its own.
 */
export function DialpadCallProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const router = useRouter();
  const lockHolder = useCallLockHolder();
  const requests = useRef(new Map<string, DialpadCallRequest>());
  const [pageHandlers, setPageHandlers] = useState<DialpadPageHandlers | null>(null);
  const { dialFlight, dialActive, lockNotice, panelHidden, startApiDial, statusHandlers } = useApiDial(
    (propertyId) => {
      const request = requests.current.get(propertyId);
      return request ? { contactId: request.contactId, label: request.label, phoneSlot: request.phoneSlot ?? null } : null;
    },
    {
      hasFallback: (propertyId) => Boolean(requests.current.get(propertyId)?.onFallback),
      onNotConfigured: (propertyId) => requests.current.get(propertyId)?.onFallback?.(),
    },
  );
  const startRef = useRef(startApiDial);
  useEffect(() => {
    startRef.current = startApiDial;
  });
  const [showHidden, setShowHidden] = useState(false);
  // The ended flight's call activity, so saving that call's attempt can clear its panel.
  const [endedCall, setEndedCall] = useState<{ callActivityId: string | null; gen: number | undefined } | null>(null);
  const clearRef = useRef<(callActivityId: string) => void>(() => undefined);
  useEffect(() => {
    clearRef.current = (callActivityId) => {
      // Only the ended flight for this exact call activity; an ended flight has already released the lock.
      if (endedCall?.callActivityId === callActivityId && dialFlight?.kind === "in_flight" && dialFlight.gen === endedCall.gen) {
        statusHandlers.onDismiss();
        setEndedCall(null);
      }
    };
  });
  const stable = useMemo<DialpadCallContextValue>(
    () => ({
      enabled,
      flight: dialFlight,
      // True for a live call AND for any other Dialpad hold (an uncertain request, a countdown), so no parallel dial is offered.
      dialActive: dialActive || lockHolder === "dialpad",
      setPageHandlers,
      clearEndedCall: (callActivityId) => clearRef.current(callActivityId),
      startCall: (request) => {
        requests.current.set(request.propertyId, request);
        setShowHidden(false);
        void startRef.current(request.propertyId, 1);
      },
    }),
    [enabled, dialFlight, dialActive, lockHolder],
  );
  // Visible whenever there is something to act on or a lock to explain, even if the route flips off mid-call.
  const hasPanel = Boolean(dialFlight || lockNotice);
  return (
    <DialpadCallContext.Provider value={stable}>
      {children}
      {hasPanel ? (
        <div data-testid="dialpad-call-status" className="fixed bottom-4 left-4 z-50 max-w-[calc(100vw-2rem)] md:left-72">
          {/* Dismiss on a live call only hides this; it stays mounted so polling (and the lock) keep working. */}
          <div hidden={panelHidden && !showHidden && !lockNotice}>
            <DialStatus
              flight={dialFlight}
              notice={lockNotice}
              {...statusHandlers}
              onDismiss={() => {
                setShowHidden(false);
                statusHandlers.onDismiss();
              }}
              onLogOutcome={pageHandlers?.onLogOutcome}
              onEnded={(status: DialpadCallStatus) => {
                setEndedCall({ callActivityId: status.callActivityId ?? null, gen: dialFlight?.gen });
                router.refresh();
                pageHandlers?.onEnded?.();
              }}
            />
          </div>
          {panelHidden && !showHidden && !lockNotice ? (
            <Button type="button" size="sm" variant="outline" data-testid="dialpad-call-show" onClick={() => setShowHidden(true)}>
              Call in progress — show status
            </Button>
          ) : null}
        </div>
      ) : null}
    </DialpadCallContext.Provider>
  );
}
