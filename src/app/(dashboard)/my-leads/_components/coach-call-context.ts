"use client";

import { createContext, useContext } from "react";

/**
 * "Call with coach" for My Leads rows: opens the Telnyx softphone on a lead so live coaching works.
 * Null (the default) unless the Dialpad route is on and the softphone is available, in which case the
 * rows render exactly as before.
 */
export type CoachCall = { call: (propertyId: string) => void; /** A Dialpad call is in flight: coach buttons stay disabled so the lead is not dialed twice. */ disabled: boolean };

export const CoachCallContext = createContext<CoachCall | null>(null);

export function useCoachCall(): CoachCall | null {
  return useContext(CoachCallContext);
}

/** The call screen for a lead (the page only opens for the rep's own queue). */
export const callScreenHref = (propertyId: string) => `/my-leads/call/${propertyId}`;

/**
 * "Open call screen" for My Leads rows. Null (the default) unless the `call_screen` flag is on and the
 * rep is looking at their own queue, in which case rows render exactly as before.
 */
export const CallScreenLinkContext = createContext<((propertyId: string) => void) | null>(null);

export function useCallScreenLink(): ((propertyId: string) => void) | null {
  return useContext(CallScreenLinkContext);
}
