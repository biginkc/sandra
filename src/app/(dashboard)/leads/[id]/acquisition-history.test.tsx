import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  AcquisitionHistoryCard,
  useAcquisitionHistory,
} from "./acquisition-history";
import type {
  AcquisitionHistoryResult,
  AcquisitionHistoryFact,
} from "@/lib/leads/acquisition-history";
const { load } = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("./acquisition-history-actions", () => ({
  loadLeadAcquisitionHistory: load,
}));
const fact: AcquisitionHistoryFact = {
  kind: "attempt",
  id: "a",
  at: "2026-01-01T10:00:00Z",
  actorId: "rep",
  source: "manual",
  attemptKind: "outreach",
  outcome: "no_answer",
  note: "<script>not code</script>",
  recordingUrl: "javascript:alert(1)",
  callActivityId: null,
};
const initial: AcquisitionHistoryResult = {
  ok: true,
  page: {
    rows: [fact],
    hasMore: true,
    cursor: { at: fact.at, kind: "attempt", id: "a" },
  },
};
function Harness({
  id,
  source = initial,
}: {
  id: string;
  source?: AcquisitionHistoryResult;
}) {
  const state = useAcquisitionHistory(id, source);
  return (
    <>
      <button onClick={state.retry}>Retry</button>
      <button onClick={state.loadMore}>More</button>
      <p>{state.error}</p>
      {state.page.rows.map((f) => (
        <span key={f.id}>{f.id}</span>
      ))}
    </>
  );
}
beforeEach(() => load.mockReset());
describe("acquisition history rendering and recovery", () => {
  it("renders literal note, actor, real timestamp and no unsafe recording link", () => {
    render(<AcquisitionHistoryCard fact={fact} actor="Rep A" />);
    expect(screen.getByText("No answer")).toBeInTheDocument();
    expect(screen.getByText(fact.note!)).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText(/Rep A/)).toBeInTheDocument();
  });
  it("retains loaded facts after page failure and retries first page", async () => {
    load
      .mockResolvedValueOnce({ ok: false, message: "History unavailable" })
      .mockResolvedValueOnce({
        ok: true,
        page: { rows: [{ ...fact, id: "b" }], hasMore: false, cursor: null },
      });
    render(<Harness id="p" />);
    fireEvent.click(screen.getByText("More"));
    await screen.findByText("History unavailable");
    expect(screen.getByText("a")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Retry"));
    await screen.findByText("b");
    expect(screen.queryByText("a")).not.toBeInTheDocument();
    expect(load).toHaveBeenLastCalledWith("p", null);
  });
  it("ignores a previous property response after navigation", async () => {
    let resolve!: (v: AcquisitionHistoryResult) => void;
    load.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const view = render(<Harness id="p" />);
    fireEvent.click(screen.getByText("More"));
    view.rerender(
      <Harness
        id="other"
        source={{
          ok: true,
          page: {
            rows: [{ ...fact, id: "other" }],
            hasMore: false,
            cursor: null,
          },
        }}
      />,
    );
    resolve({
      ok: true,
      page: { rows: [{ ...fact, id: "stale" }], hasMore: false, cursor: null },
    });
    await waitFor(() => expect(screen.getByText("other")).toBeInTheDocument());
    expect(screen.queryByText("stale")).not.toBeInTheDocument();
  });
});
