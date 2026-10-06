"use client";

import { createContext, useContext } from "react";

/**
 * "Call with coach" for My Leads rows: opens the Telnyx softphone on a lead so live coaching works.
 * Null (the default) unless the Dialpad route is on and the softphone is available, in which case the
 * rows render exactly as before.
 */
export const CoachCallContext = createContext<((propertyId: string) => void) | null>(null);

export function useCoachCall(): ((propertyId: string) => void) | null {
  return useContext(CoachCallContext);
}
