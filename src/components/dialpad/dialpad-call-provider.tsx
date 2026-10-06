"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import type { DialpadCallStatus } from "@/lib/dialpad-cti/contracts";
import { useCallLockHolder } from "@/components/calls/call-lock-context";
import { DialStatus } from "@/app/(dashboard)/my-leads/_components/dial-status";
import { useApiDial } from "@/app/(dashboard)/my-leads/_components/use-api-dial";
import { Button } from "@/components/ui/button";
import { DialpadCallContext, type DialpadCallContextValue, type DialpadCallRequest, type DialpadPageHandlers } from "./dialpad-call-context";
import { LogOutcomeHost, type LoggingViewer, type LogOutcomeRequest } from "./log-outcome-host";

type UnloggedCall = { callActivityId: string; propertyId: string; label: string };

/**
 * The single owner of every Dialpad flight and its call lock. It lives in the dashboard layout, so
 * navigating between pages never unmounts it. Lead buttons, Messages, My Leads and the call screen
 * call `startCall` and read its state; none of them runs a dial of its own.
 */
export function DialpadCallProvider({
  enabled,
  loggingViewer = null,
  children,
}: {
  enabled: boolean;
  /** Set only for acquisitions callers whose Sandra calls must be logged: turns on the in-place Log outcome prompt. */
  loggingViewer?: LoggingViewer | null;
  children: ReactNode;
}) {
  const router = useRouter();
  const lockHolder = useCallLockHolder();
  const requests = useRef(new Map<string, DialpadCallRequest>());
  // Registrations are token-scoped: the newest one is active, and an unregister only removes its own.
  const [registrations, setRegistrations] = useState<{ token: symbol; handlers: DialpadPageHandlers }[]>([]);
  const pageHandlers = registrations.length > 0 ? registrations[registrations.length - 1].handlers : null;
  const registerPageHandlers = useCallback((handlers: DialpadPageHandlers) => {
    const token = Symbol("page-handlers");
    setRegistrations((prev) => [...prev, { token, handlers }]);
    return () => setRegistrations((prev) => prev.filter((entry) => entry.token !== token));
  }, []);
  // Calls whose outcome was saved; kept so a stale poll inside its window cannot reopen the prompt.
  const [loggedCallActivityIds, setLoggedCallActivityIds] = useState<ReadonlySet<string>>(() => new Set());
  const [logRequest, setLogRequest] = useState<LogOutcomeRequest | null>(null);
  // Sandra calls that ended (or whose prompt was closed with "later") and still have no saved outcome.
  const [unlogged, setUnlogged] = useState<UnloggedCall[]>([]);
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
      setLoggedCallActivityIds((prev) => (prev.has(callActivityId) ? prev : new Set(prev).add(callActivityId)));
      setUnlogged((prev) => (prev.some((call) => call.callActivityId === callActivityId) ? prev.filter((call) => call.callActivityId !== callActivityId) : prev));
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
      registerPageHandlers,
      loggedCallActivityIds,
      openLogOutcome: loggingViewer ? (propertyId, callActivityId) => setLogRequest({ propertyId, callActivityId }) : undefined,
      markUnlogged: (call) => setUnlogged((prev) => (prev.some((c) => c.callActivityId === call.callActivityId) ? prev : [...prev, call])),
      clearEndedCall: (callActivityId) => clearRef.current(callActivityId),
      startCall: (request) => {
        requests.current.set(request.propertyId, request);
        setShowHidden(false);
        return startRef.current(request.propertyId, 1);
      },
    }),
    [enabled, dialFlight, dialActive, lockHolder, registerPageHandlers, loggedCallActivityIds, loggingViewer],
  );
  // Visible whenever there is something to act on or a lock to explain, even if the route flips off mid-call.
  const hasPanel = Boolean(dialFlight || lockNotice);
  const logOutcome = (propertyId: string, callActivityId: string) => {
    if (pageHandlers?.onLogOutcome) pageHandlers.onLogOutcome(propertyId, callActivityId);
    else if (loggingViewer) setLogRequest({ propertyId, callActivityId });
  };
  // A page that already shows this call's prompt needs no second "Log outcome" button.
  const pageShowsEnded = Boolean(endedCall?.callActivityId && pageHandlers?.showingPromptFor === endedCall.callActivityId);
  const canLogOutcome = Boolean(pageHandlers?.onLogOutcome || loggingViewer) && !pageShowsEnded;
  // The reminder skips a call whose panel or prompt is on screen right now: it is already asking.
  const panelShowing = (id: string) =>
    endedCall?.callActivityId === id && dialFlight?.kind === "in_flight" && dialFlight.gen === endedCall.gen;
  const reminders = unlogged.filter((call) => !panelShowing(call.callActivityId) && pageHandlers?.showingPromptFor !== call.callActivityId);
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
              onLogOutcome={canLogOutcome ? logOutcome : undefined}
              onEnded={(status: DialpadCallStatus) => {
                setEndedCall({ callActivityId: status.callActivityId ?? null, gen: dialFlight?.gen });
                // Acquisitions callers must log every Sandra call: it stays reminded until its outcome is saved.
                if (loggingViewer && status.callActivityId && dialFlight?.kind === "in_flight") {
                  const entry = { callActivityId: status.callActivityId, propertyId: dialFlight.propertyId, label: dialFlight.label };
                  setUnlogged((prev) => (prev.some((call) => call.callActivityId === entry.callActivityId) || loggedCallActivityIds.has(entry.callActivityId) ? prev : [...prev, entry]));
                }
                router.refresh();
                pageHandlers?.onEnded?.(
                  status.callActivityId && dialFlight?.kind === "in_flight"
                    ? {
                        propertyId: dialFlight.propertyId,
                        callActivityId: status.callActivityId,
                        endedAt: new Date().toISOString(),
                        talkSeconds: status.durationSeconds,
                      }
                    : undefined,
                );
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
      {reminders.length > 0 ? (
        <div data-testid="call-unlogged-reminder" className={`fixed left-4 z-50 max-w-[calc(100vw-2rem)] md:left-72 ${hasPanel ? "bottom-20" : "bottom-4"}`}>
          <div role="status" className="bg-card flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
            <span>{reminders.length === 1 ? "1 call not logged" : `${reminders.length} calls not logged`}</span>
            {canLogOutcome ? (
              <Button type="button" size="sm" onClick={() => logOutcome(reminders[0].propertyId, reminders[0].callActivityId)}>
                Log outcome
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {loggingViewer ? (
        <LogOutcomeHost viewer={loggingViewer} request={logRequest} onClose={() => setLogRequest(null)} onLogged={(id) => clearRef.current(id)} />
      ) : null}
    </DialpadCallContext.Provider>
  );
}
