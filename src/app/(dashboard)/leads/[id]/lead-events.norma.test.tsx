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

  it("shows the converted time, in the seller's zone and marked unconfirmed, beside the seller's words", () => {
    render(
      <LeadEventPill
        event={event("norma_call_completed", { outcome: "callback_requested", request_id: REQUEST_ID })}
        authorEmails={{}}
        currentUserId={null}
        normaRequests={[{ ...request, callback_requested_for: "2026-10-06T20:00:00.000Z", callback_timezone: "America/Chicago" }]}
      />,
    );
    const detail = screen.getByTestId("norma-event-detail");
    expect(detail).toHaveTextContent("after 5pm Central");
    expect(screen.getByTestId("norma-event-callback-time")).toHaveTextContent("Converted callback time (unconfirmed): Tue, Oct 6, 3:00 PM CDT");
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

describe("Norma timeline colours and the second call", () => {
  const pill = (outcome: string) => {
    const { unmount } = render(
      <LeadEventPill
        event={event("norma_call_completed", { outcome, request_id: REQUEST_ID })}
        authorEmails={{}}
        currentUserId={null}
        normaRequests={[]}
      />,
    );
    const row = screen.getByTestId("lead-event-row");
    const result = { tone: row.getAttribute("data-tone"), className: row.className };
    unmount();
    return result;
  };

  it("green when the call reached a person", () => {
    for (const outcome of ["reached_no_callback", "callback_requested", "not_interested", "wrong_number"]) {
      const { tone, className } = pill(outcome);
      expect(tone).toBe("green");
      expect(className).toContain("#15803d");
    }
  });

  it("grey for no answer, amber for needs review or an unknown outcome", () => {
    expect(pill("no_answer").tone).toBe("neutral");
    expect(pill("no_answer").className).not.toContain("#15803d");
    expect(pill("unknown").tone).toBe("amber");
    expect(pill("something_new").tone).toBe("amber");
  });

  it("other events keep the plain pill", () => {
    render(<LeadEventPill event={event("norma_call_requested", {}, "user")} authorEmails={{}} currentUserId={null} />);
    expect(screen.getByTestId("lead-event-row")).not.toHaveAttribute("data-tone");
  });

  it("says plainly that the first call was not answered", () => {
    expect(formatLeadEventSentence(event("norma_call_attempt_no_answer", { attempt: 1 }), {}, null)).toBe(
      "Norma's first call was not answered",
    );
  });
});
