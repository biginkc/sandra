import { createRoot } from "react-dom/client";
import { CallEventCard, type CallActivityRollupRow } from "../../../src/app/(dashboard)/leads/[id]/lead-call-summary";

const providers = ["dialpad", "jitter", "sandra_softphone", "unknown"];
createRoot(document.getElementById("root")!).render(
  <main>
    {providers.map((provider) => {
      const row: CallActivityRollupRow = {
        id: provider, provider, created_at: "2026-10-08T12:00:00Z", started_at: null,
        outcome: "connected_human", disposition: null,
        recording_status: "none", transcript_status: "none", summary_status: "none",
        jitter_attempt_id: provider, jitter_session_id: null,
        call_recordings: [], call_transcripts: [],
      };
      return <section key={provider} aria-label={provider}>
        <CallEventCard row={row} jitterHref={new URLSearchParams(location.search).has("missing") ? null : "https://jitter.example.test/history?prospect_id=property-123"} />
      </section>;
    })}
  </main>,
);
