"use client";

import { useEffect, useState, type ReactElement } from "react";

import { Badge } from "@/components/ui/badge";
import type { CoachHoldTimer } from "@/lib/coach/types";

const HOLD_TIMER_ID = "hold_timer";

/** Formats a non-negative elapsed duration for the operator-facing clock. */
export function formatHoldTimerSeconds(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(safeSeconds / 60)).padStart(2, "0")}:${String(safeSeconds % 60).padStart(2, "0")}`;
}

/**
 * Computes the remaining hold time from the server timestamp, not from when
 * this component mounted. That keeps collapse/reopen truthful and makes a
 * stale or malformed timer fail closed instead of displaying NaN.
 */
export function holdTimerRemainingSeconds(timer: CoachHoldTimer, now = Date.now()): number | null {
  const startedAt = Date.parse(timer.startedAt);
  if (
    timer.timerId !== HOLD_TIMER_ID
    || !Number.isFinite(startedAt)
    || !Number.isInteger(timer.durationS)
    || timer.durationS <= 0
  ) return null;

  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000));
  return Math.max(0, timer.durationS - elapsed);
}

/**
 * Display-only hold countdown. It never calls Hold/Resume or changes call
 * state; expiry is represented as 00:00 and the script remains untouched.
 */
export function HoldTimer({ timer }: { timer: CoachHoldTimer | null }): ReactElement | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!timer) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [timer]);

  if (!timer) return null;
  const remaining = holdTimerRemainingSeconds(timer, now);
  if (remaining === null) return null;

  return (
    <Badge
      variant={remaining <= 30 ? "destructive" : "outline"}
      data-testid="hold-timer"
      data-remaining-seconds={remaining}
      aria-label={`Hold time remaining ${formatHoldTimerSeconds(remaining)}`}
      className="h-5 text-[10px]"
    >
      {`Hold ${formatHoldTimerSeconds(remaining)}`}
    </Badge>
  );
}
