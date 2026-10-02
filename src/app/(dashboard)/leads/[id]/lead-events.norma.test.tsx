import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));

import { LeadEventPill, formatLeadEventSentence, type LeadEvent } from "./lead-events";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";

function event(event_type: string, payload: Record<string, unknown>, actor_type = "system"): LeadEvent {
  return {
    id: "e1", property_id: "p1", actor_type, actor_id: null, event_type,
    payload: payload as LeadEvent["payload"], created_at: "2026-10-02T15:00:00.000Z",
  } as LeadEvent;
}

const request = {
  id: REQUEST_ID, status: "completed", outcome: "callback_requested", summary: null,
  callback_raw: "after 5pm Central", completed_at: "2026-10-02T15:00:00.000Z",
};

describe("Norma lead timeline events", () => {
  it("renders a request event, noting when context was supplied", () => {
    expect(formatLeadEventSentence(event("norma_call_requested", { has_context: false }, "user"), {}, null)).toMatch(/asked Norma to call$/);
    expect(formatLeadEventSentence(event("norma_call_requested", { has_context: true }, "user"), {}, null)).toMatch(/asked Norma to call \(with context\)$/);
  });

  it("renders the outcome of a finished call in plain words", () => {
    const sentence = (outcome: string) =>
      formatLeadEventSentence(event("norma_call_completed", { outcome, request_id: REQUEST_ID }), {}, null);
    expect(sentence("callback_requested")).toBe("Norma call finished — Callback requested");
    expect(sentence("no_answer")).toBe("Norma call finished — No answer");
    expect(sentence("not_interested")).toBe("Norma call finished — Seller not interested");
    expect(sentence("wrong_number")).toBe("Norma call finished — Wrong number");
    expect(sentence("something_new")).toBe("Norma call finished — Needs review");
  });

  it("shows the summary and the callback preference, marked unconfirmed", () => {
    render(
      <LeadEventPill
        event={event("norma_call_completed", { outcome: "callback_requested", request_id: REQUEST_ID, summary: "Wants to sell by June." })}
        authorEmails={{}}
        currentUserId={null}
        normaRequests={[request]}
      />,
    );
    expect(screen.getByTestId("lead-event-row")).toHaveTextContent("Callback requested");
    const detail = screen.getByTestId("norma-event-detail");
    expect(detail).toHaveTextContent("Wants to sell by June.");
    expect(detail).toHaveTextContent("callback preference (unconfirmed)");
    expect(detail).toHaveTextContent("after 5pm Central");
  });

  it("falls back to the stored request summary and omits the preference when there is none", () => {
    render(
      <LeadEventPill
        event={event("norma_call_completed", { outcome: "no_answer", request_id: REQUEST_ID })}
        authorEmails={{}}
        currentUserId={null}
        normaRequests={[{ ...request, outcome: "no_answer", callback_raw: null, summary: "Stored summary" }]}
      />,
    );
    const detail = screen.getByTestId("norma-event-detail");
    expect(detail).toHaveTextContent("Stored summary");
    expect(detail).not.toHaveTextContent("unconfirmed");
  });

  it("renders only the sentence when there is nothing more to show, and for request events", () => {
    const { rerender } = render(
      <LeadEventPill event={event("norma_call_completed", { outcome: "no_answer", request_id: REQUEST_ID })} authorEmails={{}} currentUserId={null} />,
    );
    expect(screen.queryByTestId("norma-event-detail")).toBeNull();
    rerender(<LeadEventPill event={event("norma_call_requested", { has_context: false }, "user")} authorEmails={{}} currentUserId={null} normaRequests={[request]} />);
    expect(screen.queryByTestId("norma-event-detail")).toBeNull();
  });
});
