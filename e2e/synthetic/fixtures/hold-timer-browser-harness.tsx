import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { HoldTimer } from "@/components/coach/hold-timer";
import type { CoachHoldTimer } from "@/lib/coach/types";

declare global {
  interface Window {
    holdTimerHarness: Record<string, () => void>;
  }
}

function timerFromNow(offsetMs = 0): CoachHoldTimer {
  return {
    timerId: "hold_timer",
    startedAt: new Date(Date.now() - offsetMs).toISOString(),
    durationS: 180,
  };
}

function HoldTimerHarness() {
  const [timer, setTimer] = useState<CoachHoldTimer | null>(() => timerFromNow());
  const [held, setHeld] = useState(true);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    window.holdTimerHarness = {
      startHold: () => {
        setHeld(true);
        setTimer(timerFromNow());
      },
      resume: () => setHeld(false),
      holdAgain: () => {
        setHeld(true);
        setTimer(timerFromNow());
      },
      expireHold: () => setTimer(timerFromNow(180_000)),
      clearTimer: () => setTimer(null),
      collapse: () => setOpen(false),
      reopen: () => setOpen(true),
    };
  }, []);

  return (
    <main>
      <h1>Coach hold workflow</h1>
      <p data-testid="coach-script">Keep the script visible while the homeowner is on hold.</p>
      {open ? <div data-testid="coach-hold-surface"><HoldTimer timer={held ? timer : null} /></div> : <p data-testid="coach-collapsed">Coach collapsed</p>}
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root for hold timer harness");
createRoot(root).render(<HoldTimerHarness />);
