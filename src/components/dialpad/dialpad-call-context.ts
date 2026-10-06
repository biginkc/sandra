"use client";

import { createContext, useContext } from "react";

import type { SoftphoneLead } from "@/components/softphone/softphone-provider";

export type DialpadCallRequest = {
  propertyId: string;
  contactId: string;
  label: string;
  phoneSlot?: 1 | 2 | 3 | null;
  /** Runs when the server says Dialpad is not configured for this click, so the caller uses its legacy path. */
  onFallback: () => void;
};

export type DialpadCallContextValue = {
  /** Server-derived: click_to_dial on, org connection active, viewer bound, api_dial schema ready. */
  enabled: boolean;
  startCall: (request: DialpadCallRequest) => void;
  /** Opens the Telnyx softphone on a lead so live coaching works. Undefined when the softphone is unavailable. */
  callWithCoach?: (lead: SoftphoneLead) => void;
};

export const DialpadCallContext = createContext<DialpadCallContextValue | null>(null);

/** Null outside the dashboard layout; entry points treat that as "use the softphone". */
export function useOptionalDialpadCall(): DialpadCallContextValue | null {
  return useContext(DialpadCallContext);
}
