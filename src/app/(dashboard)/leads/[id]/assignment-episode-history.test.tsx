import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AssignmentEpisodeHistory, episodeLabel } from "./assignment-episode-history";

describe("<AssignmentEpisodeHistory />", () => {
  it("renders nothing when the history is unavailable or empty", () => {
    const { container, rerender } = render(<AssignmentEpisodeHistory rows={null} labels={{}} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<AssignmentEpisodeHistory rows={[]} labels={{}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("uses the My Leads wording for live, ended and launch episodes", () => {
    render(
      <AssignmentEpisodeHistory
        labels={{ u1: "Ana", u2: "Ben" }}
        rows={[
          { id: "e1", at: "2026-10-03T12:00:00Z", actorId: "u1", kind: "live", endedAt: null },
          { id: "e2", at: "2026-09-01T12:00:00Z", actorId: "u2", kind: "live", endedAt: "2026-10-03T12:00:00Z" },
          { id: "e3", at: "2026-08-01T12:00:00Z", actorId: "u2", kind: "launch", endedAt: "2026-09-01T12:00:00Z" },
        ]}
      />,
    );
    expect(screen.getByText("Assigned to Ana")).toBeInTheDocument();
    expect(screen.getByText("Assigned to Ben (ended)")).toBeInTheDocument();
    expect(screen.getByText("Initialized for Ben (ended)")).toBeInTheDocument();
  });

  it("falls back to Team member for an unknown actor", () => {
    expect(episodeLabel({ kind: "live", actorId: "gone", endedAt: null }, {})).toBe("Assigned to Team member");
  });
});
