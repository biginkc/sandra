import { createRoot } from "react-dom/client";
import { LeadAppointmentsSection, type LeadAppointmentRow } from "@/app/(dashboard)/leads/[id]/lead-appointments-section";
import { AssignmentEpisodeHistory } from "@/app/(dashboard)/leads/[id]/assignment-episode-history";
import { AcquisitionHistoryCard } from "@/app/(dashboard)/leads/[id]/acquisition-history";

// Synthetic lead: real lead-page components, no database, no provider.
const params = new URLSearchParams(window.location.search);
const viewer = params.get("viewer") ?? "rep-1";
const NOW = new Date("2026-10-15T15:00:00Z").getTime();
const at = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();
const row = (id: string, o: Partial<LeadAppointmentRow>): LeadAppointmentRow => ({
  id, title: id, due_at: at(24), end_at: null, assignee_id: "rep-1", type: "appointment", status: "open", outcome: null, ...o,
});

const live: LeadAppointmentRow[] = [
  row("Walkthrough upcoming", { due_at: at(48) }),
  row("Snoozed walkthrough", { due_at: at(72), status: "snoozed" }),
  row("Callback tomorrow", { type: "callback", due_at: at(20) }),
  row("Callback next week", { type: "callback", due_at: at(160) }),
  row("Snoozed callback", { type: "callback", due_at: at(30), status: "snoozed" }),
  row("Missed walkthrough", { due_at: at(-5) }),
];
const history = Array.from({ length: 25 }, (_, i) =>
  row(`Old appointment ${i + 1}`, { id: `old-${i + 1}`, due_at: at(-100 - i), status: i % 2 ? "cancelled" : "completed", outcome: i % 2 ? null : "held" }));

const calls: string[] = [];
Object.assign(window, {
  __leadPage: {
    calls,
    async loadHistory(_propertyId: string, cursor: { id: string } | null) {
      calls.push(cursor?.id ?? "first");
      const start = cursor ? history.findIndex((r) => r.id === cursor.id) + 1 : 0;
      const rows = history.slice(start, start + 20);
      const hasMore = start + 20 < history.length;
      const last = rows.at(-1);
      return { ok: true, rows, hasMore, cursor: hasMore && last ? { dueAt: last.due_at, id: last.id } : null };
    },
  },
});

function Harness() {
  const first = history.slice(0, 20);
  return (
    <main style={{ maxWidth: 720, padding: 16 }}>
      <LeadAppointmentsSection
        propertyId="11111111-1111-4111-8111-111111111111"
        appointments={live}
        history={{ rows: first, hasMore: true, cursor: { dueAt: first[19].due_at, id: first[19].id } }}
        viewerId={viewer}
        viewerIsOwner={params.get("owner") === "1"}
        timezone="America/Chicago"
        nowMs={NOW}
      />
      <AssignmentEpisodeHistory
        labels={{ "rep-1": "Ana", "rep-0": "Ben" }}
        rows={[
          { id: "e2", at: at(-200), actorId: "rep-1", kind: "live", endedAt: null },
          { id: "e1", at: at(-900), actorId: "rep-0", kind: "launch", endedAt: at(-200) },
        ]}
      />
      <AcquisitionHistoryCard
        actor="Ana"
        fact={{
          kind: "attempt", id: "att-1", at: at(-3), actorId: "rep-1", source: "dialpad", attemptKind: "call",
          outcome: "no_answer", note: null, recordingUrl: null, callActivityId: null,
          followUpObligationId: "ob-1", followUpStatus: "blocked", followUpMessage: "No consent on file", followUpBlockedReason: "sms_opt_out",
        }}
      />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Harness />);
