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
  /** Runs when a call ends. `info` carries the ended call so a page can open its own prompt for it. */
  onEnded?: (info?: DialpadEndedCall) => void;
  /** The call activity this page is already showing a prompt for; the panel and reminder then stay quiet about it. */
  showingPromptFor?: string | null;
};

export type DialpadEndedCall = {
  propertyId: string;
  callActivityId: string;
  endedAt: string;
  talkSeconds: number | null;
};

export type DialpadCallContextValue = {
  /** The one Dialpad flight (owned by the persistent provider) and whether its call is still live. */
  flight?: DialFlight | null;
  dialActive?: boolean;
  /** The attempt for this call activity was saved: clear its ended flight's panel (a no-op for any other flight). */
  clearEndedCall?: (callActivityId: string) => void;
  /**
   * Register page-level handlers (Log outcome, refresh on end). Returns an unregister that only removes
   * THIS registration, so a page that unmounts after the next page registered cannot clear the newer handlers.
   */
  registerPageHandlers?: (handlers: DialpadPageHandlers) => () => void;
  /** Call activities whose outcome was saved this session; a stale poll must never reopen their prompt. */
  loggedCallActivityIds?: ReadonlySet<string>;
  /**
   * A prompt for this Sandra call was closed without saving. That means "later", never "dismissed": the
   * call stays on the rep's "not logged" reminder until its outcome is saved (clearEndedCall).
   */
  markUnlogged?: (call: { callActivityId: string; propertyId: string; label: string }) => void;
  /** Open the Log outcome prompt for an ended call right where the rep is (no navigation). Absent when the viewer cannot log. */
  openLogOutcome?: (propertyId: string, callActivityId: string) => void;
  /** Server-derived: click_to_dial on, org connection active, viewer bound, api_dial schema ready. */
  enabled: boolean;
  /** Resolves true when the dial was accepted, false when it was refused (another call holds the lock, no contact, error, fallback). A page navigates to the call screen only on true. */
  startCall: (request: DialpadCallRequest) => Promise<boolean>;
};

export const DialpadCallContext = createContext<DialpadCallContextValue | null>(null);

/** Null outside the dashboard layout; entry points treat that as "use the softphone". */
export function useOptionalDialpadCall(): DialpadCallContextValue | null {
  return useContext(DialpadCallContext);
}
