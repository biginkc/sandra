"use client";

import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import { DialStatus } from "@/app/(dashboard)/my-leads/_components/dial-status";
import { DialpadCallContext, type DialpadCallContextValue, type DialpadCallRequest } from "./dialpad-call-context";
import { useApiDial } from "@/app/(dashboard)/my-leads/_components/use-api-dial";

/**
 * One shared Dialpad dial path for every Call button outside My Leads (which owns its own). It reuses the
 * My Leads hook (per-lead idempotency keys, same dialLeadAction server action) and its status panel, so
 * denied, quiet-hours, prior-call-unresolved and rate-limit outcomes read the same everywhere.
 */
export function DialpadCallProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const router = useRouter();
  const requests = useRef(new Map<string, DialpadCallRequest>());
  const { dialFlight, lockNotice, startApiDial, statusHandlers } = useApiDial(
    (propertyId) => {
      const request = requests.current.get(propertyId);
      return request ? { contactId: request.contactId, label: request.label, phoneSlot: request.phoneSlot ?? null } : null;
    },
    { onNotConfigured: (propertyId) => requests.current.get(propertyId)?.onFallback() },
  );
  const startRef = useRef(startApiDial);
  useEffect(() => {
    startRef.current = startApiDial;
  });
  const stable = useMemo<DialpadCallContextValue>(
    () => ({
      enabled,
      startCall: (request) => {
        requests.current.set(request.propertyId, request);
        void startRef.current(request.propertyId, 1);
      },
    }),
    [enabled],
  );
  return (
    <DialpadCallContext.Provider value={stable}>
      {children}
      {enabled && (dialFlight || lockNotice) ? (
        <div data-testid="dialpad-call-status" className="fixed bottom-4 left-4 z-50 max-w-[calc(100vw-2rem)] md:left-72">
          <DialStatus flight={dialFlight} notice={lockNotice} {...statusHandlers} onEnded={() => router.refresh()} />
        </div>
      ) : null}
    </DialpadCallContext.Provider>
  );
}
