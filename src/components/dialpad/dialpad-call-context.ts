"use client";

import { createContext, useContext } from "react";

import type { DialFlight } from "@/app/(dashboard)/my-leads/_components/dial-status";

export type DialpadCallRequest = {
  propertyId: string;
  contactId: string;
  label: string;
  phoneSlot?: 1 | 2 | 3 | null;
  /** Runs when the server says Dialpad is not configured for this click, so the caller uses its legacy path. Omit when there is none (the refusal is shown instead). */
  onFallback?: () => void;
};

/** Hooks a page registers while mounted; the provider (which outlives navigation) calls them. */
export type DialpadPageHandlers = {
  onLogOutcome?: (propertyId: string, callActivityId: string) => void;
  onEnded?: () => void;
};

export type DialpadCallContextValue = {
  /** The one Dialpad flight (owned by the persistent provider) and whether its call is still live. */
  flight?: DialFlight | null;
  dialActive?: boolean;
  /** Register page-level handlers (Log outcome, refresh on end). Returns nothing; pass null on unmount. */
  setPageHandlers?: (handlers: DialpadPageHandlers | null) => void;
  /** Server-derived: click_to_dial on, org connection active, viewer bound, api_dial schema ready. */
  enabled: boolean;
  startCall: (request: DialpadCallRequest) => void;
};

export const DialpadCallContext = createContext<DialpadCallContextValue | null>(null);

/** Null outside the dashboard layout; entry points treat that as "use the softphone". */
export function useOptionalDialpadCall(): DialpadCallContextValue | null {
  return useContext(DialpadCallContext);
}
