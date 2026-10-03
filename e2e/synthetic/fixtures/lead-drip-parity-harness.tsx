import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { LeadDripCard, LeadOutcomeProvider, LeadOutcomeSection } from "@/app/(dashboard)/leads/[id]/lead-outcome-section";
import { toOutcomeBarDrip } from "@/app/(dashboard)/leads/[id]/lead-outcome-drip";
import type { DripProgress } from "@/lib/sequences/drip-progress";

// Synthetic server boundaries; real lead-page components and picker are bundled.
const params = new URLSearchParams(window.location.search);
const state = { outcome: "nurture", progress: null as DripProgress | null, guardedStarts: 0, directStarts: 0, refreshes: 0 };
export const backend = {
  state,
  async startDirect() {
    state.directStarts++;
    return { ok: true, data: { results: [{ status: "skipped", reason: "Nurture requires an outcome change." }] } };
  },
  async startWithOutcome() {
    state.guardedStarts++;
    if (params.get("case") === "dnc") return { ok: false, error: "This lead is do not contact or opted out." };
    state.outcome = "needs_sequence";
    if (params.get("case") === "partial") return { ok: true, enrollment: { status: "failed", reason: "Synthetic enrollment failure" } };
    state.progress = {
      propertyId: "synthetic-lead", enrollmentId: "synthetic-enrollment", sequenceId: "synthetic-drip",
      enrollmentStatus: "active", sequenceName: "Confirmed owner", step: 1, totalSteps: 11,
      nextTextAt: "2026-10-04T23:19:00Z", lastText: null, status: "Waiting", reason: null,
    };
    return { ok: true, enrollment: { status: "enrolled", reason: "Enrolled" } };
  },
  refresh() {
    state.refreshes++;
    window.dispatchEvent(new Event("synthetic-server-refresh"));
  },
};
Object.assign(window, { __dripBackend: backend });

function Harness() {
  const [, renderServerSnapshot] = useState(0);
  useEffect(() => {
    const refresh = () => renderServerSnapshot((value) => value + 1);
    window.addEventListener("synthetic-server-refresh", refresh);
    return () => window.removeEventListener("synthetic-server-refresh", refresh);
  }, []);
  return <main>
    <p>Synthetic lead — no database or SMS provider</p>
    <LeadOutcomeProvider>
      <LeadOutcomeSection propertyId="synthetic-lead" address="Synthetic address" initialDispo={state.outcome}
        propertyStatus="new_lead" currentUserId="synthetic-user" drip={toOutcomeBarDrip(state.progress)} dripUnknown={false} />
      <LeadDripCard propertyId="synthetic-lead" />
    </LeadOutcomeProvider>
    <output data-testid="server-outcome">{state.outcome}</output>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
