"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import { DialStatus } from "@/app/(dashboard)/my-leads/_components/dial-status";
import { useOptionalSoftphone } from "@/components/softphone/softphone-provider";
import { DialpadCallContext, type DialpadCallContextValue, type DialpadCallRequest } from "./dialpad-call-context";
import { useApiDial } from "@/app/(dashboard)/my-leads/_components/use-api-dial";

/**
 * One shared Dialpad dial path for every Call button outside My Leads (which owns its own). It reuses the
 * My Leads hook (per-lead idempotency keys, same dialLeadAction server action) and its status panel, so
 * denied, quiet-hours, prior-call-unresolved and rate-limit outcomes read the same everywhere.
 */
export function DialpadCallProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const router = useRouter();
  const softphone = useOptionalSoftphone();
  const softphoneBusy = softphone?.busy === true;
  const [notice, setNotice] = useState<string | null>(null);
  const requests = useRef(new Map<string, DialpadCallRequest>());
  const { dialFlight, dialActive, dialPending, startApiDial, statusHandlers } = useApiDial(
    (propertyId) => {
      const request = requests.current.get(propertyId);
      return request ? { contactId: request.contactId, label: request.label, phoneSlot: request.phoneSlot ?? null } : null;
    },
    { onNotConfigured: (propertyId) => requests.current.get(propertyId)?.onFallback() },
  );
  const dialBusy = dialActive || dialPending;
  const startRef = useRef(startApiDial);
  useEffect(() => {
    startRef.current = startApiDial;
  });
  const stable = useMemo<DialpadCallContextValue>(
    () => ({
      enabled,
      dialActive: dialBusy,
      startCall: (request) => {
        // The softphone is on a call: never start a second one through Dialpad.
        if (softphoneBusy) {
          setNotice("Finish your current call before starting another.");
          return;
        }
        setNotice(null);
        requests.current.set(request.propertyId, request);
        void startRef.current(request.propertyId, 1);
      },
    }),
    [enabled, dialBusy, softphoneBusy],
  );
  return (
    <DialpadCallContext.Provider value={stable}>
      {children}
      {enabled && notice ? (
        <div data-testid="dialpad-call-notice" role="status" className="fixed bottom-4 left-4 z-50 flex max-w-[calc(100vw-2rem)] items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm md:left-72">
          <span>{notice}</span>
          <button type="button" className="underline" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      ) : null}
      {enabled && dialFlight ? (
        <div data-testid="dialpad-call-status" className="fixed bottom-4 left-4 z-50 max-w-[calc(100vw-2rem)] md:left-72">
          <DialStatus flight={dialFlight} {...statusHandlers} onEnded={() => router.refresh()} />
        </div>
      ) : null}
    </DialpadCallContext.Provider>
  );
}
