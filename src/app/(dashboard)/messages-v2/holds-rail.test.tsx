import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { BacklogPage, LoadBacklog } from "./hold-action-types";
import { ageTone, HoldsRail } from "./holds-rail";
import type { HoldsSplit, OpenHold, PipelineRunStep, RunWithSteps } from "./types";

const NOW = Date.parse("2026-10-08T12:00:00Z");
const iso = (minsAgo: number) => new Date(NOW - minsAgo * 60_000).toISOString();

const hold = (
  id: string,
  minsAgo: number,
  steps: PipelineRunStep[] = [],
  over: Partial<RunWithSteps> = {},
  withRun = true,
): OpenHold<RunWithSteps> => ({
  id,
  property_id: id,
  conversation_id: `c-${id}`,
  sources: ["needs_attention"],
  since: iso(minsAgo),
  reason: "Needs attention",
  run: withRun
    ? {
        id: `r-${id}`,
        org_id: "o",
        inbound_message_id: `m-${id}`,
        property_id: id,
        contact_id: null,
        conversation_id: `c-${id}`,
        status: "closed",
        mode: "automatic",
        final_outcome: null,
        reason: null,
        classification_run_id: null,
        claim_id: null,
        outbound_message_id: null,
        inbound_preview: `preview ${id}`,
        started_at: iso(minsAgo),
        completed_at: iso(minsAgo),
        steps,
        ...over,
      }
    : null,
});
const holdStep = (
  run_id: string,
  name: string,
  detail: Record<string, unknown> = {},
): PipelineRunStep => ({
  id: `s-${run_id}`,
  run_id,
  org_id: "o",
  seq: 1,
  kind: "hold",
  name,
  result: "held",
  detail,
  created_at: "",
});

describe("ageTone", () => {
  it("is neutral under an hour, amber over 1h, red over 4h", () => {
    expect(ageTone(30 * 60_000)).toBe("neutral");
    expect(ageTone(61 * 60_000)).toBe("amber");
    expect(ageTone(241 * 60_000)).toBe("red");
  });
});

describe("HoldsRail", () => {
  it("is its own scroll container on desktop with a sticky header", () => {
    render(<HoldsRail holds={[hold("a", 5)]} labels={new Map()} nowMs={NOW} />);
    const rail = screen.getByLabelText("Holds");
    expect(rail).toHaveClass("lg:overflow-y-auto", "lg:min-h-0");
    expect(within(rail).getByRole("heading", { name: /Holds/ })).toHaveClass("lg:sticky", "lg:top-0");
  });

  it("shows the latest alert delivery status on the hold card (failures are visible, not silent)", () => {
    render(
      <HoldsRail
        holds={[
          { ...hold("a", 5), alert: { status: "skipped", reason: "no_token" } },
          { ...hold("b", 5), alert: { status: "failed", reason: "slack_no_receipt" } },
          { ...hold("c", 5), alert: { status: "sent", reason: null } },
          hold("d", 5),
        ]}
        labels={new Map()}
        nowMs={NOW}
      />,
    );
    const cards = screen.getAllByTestId("hold-card");
    expect(within(cards[0]).getByTestId("hold-alert")).toHaveTextContent("alert: skipped (no_token)");
    expect(within(cards[1]).getByTestId("hold-alert")).toHaveTextContent("alert: failed");
    expect(within(cards[1]).getByTestId("hold-alert")).toHaveAttribute("data-status", "failed");
    expect(within(cards[2]).getByTestId("hold-alert")).toHaveTextContent("alert: sent");
    expect(within(cards[3]).queryByTestId("hold-alert")).toBeNull();
  });

  it("renders holds in the order given with why-held and age badges", () => {
    render(
      <HoldsRail
        holds={[
          hold("a", 300, [holdStep("a", "needs_human_review")]),
          hold("b", 90),
          hold("c", 5),
        ]}
        labels={new Map()}
        nowMs={NOW}
      />,
    );
    const cards = screen.getAllByTestId("hold-card");
    expect(cards).toHaveLength(3);
    expect(
      within(cards[0]).getByText(/needs_human_review/),
    ).toBeInTheDocument();
    expect(within(cards[0]).getByTestId("hold-age")).toHaveAttribute(
      "data-tone",
      "red",
    );
    expect(within(cards[1]).getByTestId("hold-age")).toHaveAttribute(
      "data-tone",
      "amber",
    );
    expect(within(cards[2]).getByTestId("hold-age")).toHaveAttribute(
      "data-tone",
      "neutral",
    );
  });

  it("falls back to the run reason when there is no hold step", () => {
    render(
      <HoldsRail
        holds={[hold("a", 5, [], { reason: "low_confidence" })]}
        labels={new Map()}
        nowMs={NOW}
      />,
    );
    expect(screen.getByText(/low_confidence/)).toBeInTheDocument();
  });

  it("renders a runless fallback card from the hold itself (older than the seam)", () => {
    render(
      <HoldsRail
        holds={[hold("a", 5, [], {}, false)]}
        labels={new Map()}
        nowMs={NOW}
      />,
    );
    expect(screen.getByTestId("hold-card")).toHaveTextContent(
      "Needs attention",
    );
    expect(screen.queryByText(/preview a/)).not.toBeInTheDocument();
  });

  it("shows the hold step even when the run status is closed", () => {
    render(
      <HoldsRail
        holds={[
          hold("a", 5, [holdStep("a", "needs_human_review")], {
            status: "closed",
          }),
        ]}
        labels={new Map()}
        nowMs={NOW}
      />,
    );
    expect(screen.getByText(/needs_human_review/)).toBeInTheDocument();
  });

  it("renders the actions disabled (not hidden) when no action handlers are supplied", () => {
    render(<HoldsRail holds={[hold("a", 5)]} labels={new Map()} nowMs={NOW} />);
    for (const name of ["Send", "Edit", "Take over", "Assign", "Dismiss"]) {
      expect(screen.getByRole("button", { name: new RegExp(`^${name}`) })).toBeDisabled();
    }
  });

  it("shows the empty state and the shadow scorecard placeholder", () => {
    render(<HoldsRail holds={[]} labels={new Map()} nowMs={NOW} />);
    expect(screen.getByText(/no open holds/i)).toBeInTheDocument();
    expect(
      screen.getByText(/available after 2h of shadow traffic/i),
    ).toBeInTheDocument();
  });
});

describe("HoldsRail degraded states", () => {
  const meta = (over: Partial<import("./types").HoldsMeta> = {}) => ({
    total: 0,
    shown: 0,
    truncated: false,
    totalState: "exact" as const,
    failed: [],
    contextErrors: [],
    ...over,
  });
  it("shows an explicit unavailable state, not an empty rail, when a source failed", () => {
    render(
      <HoldsRail
        holds={[]}
        labels={new Map()}
        nowMs={NOW}
        meta={meta({ failed: ["jev_decision"] })}
      />,
    );
    expect(screen.getByTestId("holds-unavailable")).toHaveTextContent(
      "Holds unavailable — Jev decision query failed",
    );
    expect(screen.queryByText("No open holds.")).toBeNull();
  });
  it("shows total and shown when truncated", () => {
    render(
      <HoldsRail
        holds={[hold("a", 5)]}
        labels={new Map()}
        nowMs={NOW}
        meta={meta({ total: 350, shown: 1, truncated: true })}
      />,
    );
    expect(
      screen.getByRole("heading", { name: /350, 1 shown/ }),
    ).toBeInTheDocument();
  });
  it("labels a capped total as incomplete and an unavailable count explicitly", () => {
    const { unmount } = render(
      <HoldsRail
        holds={[hold("a", 5)]}
        labels={new Map()}
        nowMs={NOW}
        meta={meta({
          total: 2000,
          shown: 1,
          truncated: true,
          totalState: "capped",
        })}
      />,
    );
    expect(
      screen.getByRole("heading", { name: /2,000\+ holds \(incomplete\)/ }),
    ).toBeInTheDocument();
    unmount();
    render(
      <HoldsRail
        holds={[hold("a", 5)]}
        labels={new Map()}
        nowMs={NOW}
        meta={meta({ totalState: "unavailable" })}
      />,
    );
    expect(
      screen.getByRole("heading", { name: /count unavailable/ }),
    ).toBeInTheDocument();
  });
  it("shows 'draft status unavailable' when the drafts query failed, without hiding holds", () => {
    render(
      <HoldsRail
        holds={[hold("a", 5)]}
        labels={new Map()}
        nowMs={NOW}
        meta={meta({ failed: ["pending_draft"] })}
      />,
    );
    expect(screen.getByTestId("holds-unavailable")).toHaveTextContent(
      "Holds unavailable — reply draft",
    );
    expect(screen.getAllByTestId("hold-card")).toHaveLength(1);
  });
  it("never says 'No open holds' when only the drafts query failed", () => {
    render(
      <HoldsRail
        holds={[]}
        labels={new Map()}
        nowMs={NOW}
        meta={meta({ failed: ["pending_draft"], totalState: "unavailable" })}
      />,
    );
    expect(screen.getByTestId("holds-unavailable")).toHaveTextContent(
      "Holds unavailable — reply draft",
    );
    expect(screen.queryByText("No open holds.")).toBeNull();
  });
  it("labels a truncated-source total as incomplete", () => {
    render(
      <HoldsRail
        holds={[hold("a", 5)]}
        labels={new Map()}
        nowMs={NOW}
        meta={meta({
          total: 1,
          shown: 1,
          truncated: true,
          totalState: "incomplete",
        })}
      />,
    );
    const h = screen.getByRole("heading", { name: /incomplete/ });
    expect(h).toHaveTextContent("1+ holds (incomplete)");
    expect(h).not.toHaveTextContent("2,000");
  });
  it("shows the dead-letter marker on a hold with saved reply text", () => {
    render(
      <HoldsRail
        holds={[{ ...hold("a", 5), dead_letter: true }, hold("b", 5)]}
        labels={new Map()}
        nowMs={NOW}
      />,
    );
    expect(screen.getAllByTestId("dead-letter")).toHaveLength(1);
    expect(screen.getByTestId("dead-letter")).toHaveTextContent(
      "reply text saved for review",
    );
  });
  it("renders both lines when a hold has one late and one non-late dead-letter", () => {
    render(
      <HoldsRail
        holds={[
          {
            ...hold("a", 5),
            flag_reason: "send_timeout_then_sent",
            dead_letter: true,
            dead_letter_late: true,
            dead_letters: [
              { inbound_message_id: "m1", run_id: "r1", late: true },
              { inbound_message_id: "m2", run_id: "r2", late: false },
            ],
          },
        ]}
        labels={new Map()}
        nowMs={NOW}
      />,
    );
    expect(screen.getByTestId("dead-letter-late")).toHaveTextContent(
      "reply accepted by provider late — do not re-send",
    );
    expect(screen.getByTestId("dead-letter")).toHaveTextContent(
      "reply text saved for review",
    );
    expect(screen.getByTestId("hold-card")).not.toHaveAttribute(
      "data-informational",
    );
  });
  it("is informational only when every dead-letter is late", () => {
    render(
      <HoldsRail
        holds={[
          {
            ...hold("a", 5),
            flag_reason: "send_timeout_then_sent",
            dead_letter: true,
            dead_letter_late: true,
            dead_letters: [
              { inbound_message_id: "m1", run_id: "r1", late: true },
              { inbound_message_id: "m2", run_id: "r2", late: true },
            ],
          },
        ]}
        labels={new Map()}
        nowMs={NOW}
      />,
    );
    expect(screen.getByTestId("hold-card")).toHaveAttribute(
      "data-informational",
      "true",
    );
    expect(screen.queryByTestId("dead-letter")).toBeNull();
  });
  it("shows accepted-late instead of saved-for-review when sent_late exists", () => {
    render(
      <HoldsRail
        holds={[{ ...hold("a", 5), dead_letter: true, dead_letter_late: true }]}
        labels={new Map()}
        nowMs={NOW}
      />,
    );
    expect(screen.getByTestId("dead-letter-late")).toHaveTextContent(
      "reply accepted by provider late — do not re-send",
    );
    expect(screen.queryByTestId("dead-letter")).toBeNull();
    expect(screen.queryByText(/saved for review/)).toBeNull();
  });
  it("renders a send_timeout_then_sent flag-only hold as muted informational", () => {
    render(
      <HoldsRail
        holds={[
          {
            ...hold("a", 5),
            flag_reason: "send_timeout_then_sent",
            dead_letter_late: true,
          },
          { ...hold("b", 5), flag_reason: "send_timeout" },
        ]}
        labels={new Map()}
        nowMs={NOW}
      />,
    );
    const cards = screen.getAllByTestId("hold-card");
    expect(cards[0]).toHaveAttribute("data-informational", "true");
    expect(cards[0]).toHaveClass("opacity-70");
    expect(cards[1]).not.toHaveAttribute("data-informational");
    expect(
      within(cards[0]).getByText("Informational — accepted by provider late"),
    ).toBeInTheDocument();
  });
  it("says dead-letter status unavailable when that lookup failed", () => {
    render(
      <HoldsRail
        holds={[hold("a", 5)]}
        labels={new Map()}
        nowMs={NOW}
        meta={meta({ deadLetterUnavailable: true })}
      />,
    );
    expect(screen.getByTestId("dead-letter-unavailable")).toHaveTextContent(
      "dead-letter status unavailable",
    );
  });
  it("flags context lookup errors", () => {
    render(
      <HoldsRail
        holds={[]}
        labels={new Map()}
        nowMs={NOW}
        meta={meta({ contextErrors: ["step lookup"] })}
      />,
    );
    expect(screen.getByTestId("holds-context-errors")).toHaveTextContent(
      "step lookup",
    );
  });
  it("shows 'age unknown' when the hold time is unknown", () => {
    const h = { ...hold("a", 5), since: null };
    render(<HoldsRail holds={[h]} labels={new Map()} nowMs={NOW} />);
    expect(screen.getByTestId("hold-age")).toHaveTextContent("age unknown");
  });
  it("shows the draft-held fact (no body unless the page loaded it) when a pending draft exists", () => {
    render(
      <HoldsRail
        holds={[{ ...hold("a", 5), draft_held: true }, hold("b", 5)]}
        labels={new Map()}
        nowMs={NOW}
      />,
    );
    expect(screen.getAllByTestId("draft-held")).toHaveLength(1);
    expect(screen.getByTestId("draft-held")).toHaveTextContent("Claude draft held");
    expect(screen.queryByTestId("draft-text")).toBeNull();
  });
});

describe("HoldsRail New / Backlog split", () => {
  const split = (over: Partial<HoldsSplit> = {}): HoldsSplit => ({
    backlogBefore: "2026-10-08T00:00:00Z",
    newTotal: 2,
    newShown: 2,
    backlogTotal: 2504,
    ...over,
  });
  const page = (ids: string[], over: Partial<BacklogPage> = {}): BacklogPage => ({
    holds: ids.map((id) => hold(id, 60 * 24 * 90)),
    labels: ids.map((id) => [id, { name: `Seller ${id}`, address: null }]),
    backlogTotal: 2504,
    hasMore: false,
    nextOffset: ids.length,
    ...over,
  });
  const ok = (data: BacklogPage) => ({ ok: true as const, data });
  const rail = (loadBacklog?: LoadBacklog, s: HoldsSplit = split(), holds = [hold("n1", 90), hold("n2", 10)]) =>
    render(<HoldsRail holds={holds} labels={new Map()} nowMs={NOW} split={s} loadBacklog={loadBacklog} backlogRefreshKey={holds} />);

  it("keeps the exact 'Holds' rail label, the independent scroll and the sticky heading", () => {
    rail();
    const aside = screen.getByLabelText("Holds");
    expect(aside).toHaveClass("lg:overflow-y-auto", "lg:min-h-0");
    const heading = within(aside).getByRole("heading", { name: /^Holds/ });
    expect(heading).toHaveClass("lg:sticky", "lg:top-0");
    expect(heading).toHaveTextContent("Holds (2 new · 2,504 backlog)");
  });

  it("shows New first with its count and the age tones (amber over 1h, red over 4h)", () => {
    rail(undefined, split({ newTotal: 3, newShown: 3 }), [hold("a", 5), hold("b", 90), hold("c", 300)]);
    const section = screen.getByLabelText("New holds");
    expect(within(section).getByRole("heading", { name: "New (3)" })).toBeInTheDocument();
    const tones = within(section).getAllByTestId("hold-age").map((el) => el.getAttribute("data-tone"));
    expect(tones).toEqual(["neutral", "amber", "red"]);
    const all = screen.getByLabelText("Holds").querySelectorAll("[data-testid=holds-new], [data-testid=holds-backlog]");
    expect([...all].map((el) => el.getAttribute("data-testid"))).toEqual(["holds-new", "holds-backlog"]);
  });

  it("collapses Backlog by default: count and one-line explanation, no cards, nothing fetched", () => {
    const load = vi.fn();
    rail(load);
    const backlog = screen.getByLabelText("Backlog holds");
    const toggle = within(backlog).getByRole("button", { name: /Backlog \(2,504\)/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(within(backlog).getByText("Flagged before Messages v2 went live")).toBeInTheDocument();
    expect(within(backlog).queryAllByTestId("hold-card")).toHaveLength(0);
    expect(load).not.toHaveBeenCalled();
  });

  it("opening Backlog loads the first page of 200, oldest first, with the existing card UI", async () => {
    const load = vi.fn<LoadBacklog>().mockResolvedValue(ok(page(["o1", "o2"])));
    rail(load);
    await userEvent.click(screen.getByRole("button", { name: /Backlog/ }));
    expect(screen.getByRole("button", { name: /Backlog/ })).toHaveAttribute("aria-expanded", "true");
    const backlog = screen.getByLabelText("Backlog holds");
    await waitFor(() => expect(within(backlog).getAllByTestId("hold-card")).toHaveLength(2));
    expect(load).toHaveBeenCalledWith({ offset: 0, limit: 200 });
    expect(within(backlog).getByText("Seller o1")).toBeInTheDocument();
    expect(within(backlog).queryByRole("button", { name: /Load more/ })).toBeNull();
  });

  it("Load more appends the next page from the current offset and drops the button on the last page", async () => {
    const load = vi
      .fn<LoadBacklog>()
      .mockResolvedValueOnce(ok(page(["o1", "o2"], { hasMore: true })))
      .mockResolvedValueOnce(ok(page(["o3"], { hasMore: false })));
    rail(load);
    await userEvent.click(screen.getByRole("button", { name: /Backlog/ }));
    const more = await screen.findByRole("button", { name: /Load more \(2,502 left\)/ });
    await userEvent.click(more);
    const backlog = screen.getByLabelText("Backlog holds");
    await waitFor(() => expect(within(backlog).getAllByTestId("hold-card")).toHaveLength(3));
    expect(load).toHaveBeenLastCalledWith({ offset: 2, limit: 200 });
    expect(within(backlog).queryByRole("button", { name: /Load more/ })).toBeNull();
  });

  it("Load more pages by property ids (nextOffset), not by how many cards rendered", async () => {
    // 3 property ids on the first page but only 2 rendered cards (one had no hold row).
    const load = vi
      .fn<LoadBacklog>()
      .mockResolvedValueOnce(ok(page(["o1", "o2"], { hasMore: true, nextOffset: 3 })))
      .mockResolvedValueOnce(ok(page(["o4"], { hasMore: true, nextOffset: 6 })))
      .mockResolvedValueOnce(ok(page(["o7"], { hasMore: false, nextOffset: 7 })));
    rail(load);
    await userEvent.click(screen.getByRole("button", { name: /Backlog/ }));
    await userEvent.click(await screen.findByRole("button", { name: /Load more/ }));
    await waitFor(() => expect(load).toHaveBeenLastCalledWith({ offset: 3, limit: 200 }));
    await userEvent.click(await screen.findByRole("button", { name: /Load more/ }));
    await waitFor(() => expect(load).toHaveBeenLastCalledWith({ offset: 6, limit: 200 }));
  });

  it("collapsing hides the cards again and re-opening does not refetch needlessly beyond the open effect", async () => {
    const load = vi.fn<LoadBacklog>().mockResolvedValue(ok(page(["o1"])));
    rail(load);
    const toggle = screen.getByRole("button", { name: /Backlog/ });
    await userEvent.click(toggle);
    await screen.findByText("Seller o1");
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(within(screen.getByLabelText("Backlog holds")).queryAllByTestId("hold-card")).toHaveLength(0);
  });

  it("reloads an open Backlog when the server data refreshes (a dismissed hold does not linger)", async () => {
    const load = vi
      .fn<LoadBacklog>()
      .mockResolvedValueOnce(ok(page(["o1", "o2"])))
      .mockResolvedValueOnce(ok(page(["o2"], { backlogTotal: 2503 })));
    const first = [hold("n1", 5)];
    const { rerender } = render(
      <HoldsRail holds={first} labels={new Map()} nowMs={NOW} split={split()} loadBacklog={load} backlogRefreshKey={first} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Backlog/ }));
    await screen.findByText("Seller o1");
    const next = [hold("n1", 5)];
    rerender(<HoldsRail holds={next} labels={new Map()} nowMs={NOW} split={split({ backlogTotal: 2503 })} loadBacklog={load} backlogRefreshKey={next} />);
    await waitFor(() => expect(screen.queryByText("Seller o1")).toBeNull());
    expect(screen.getByText("Seller o2")).toBeInTheDocument();
    expect(load).toHaveBeenLastCalledWith({ offset: 0, limit: 200 });
  });

  it("shows an error, not an empty list, when the Backlog fails to load", async () => {
    const load = vi.fn<LoadBacklog>().mockResolvedValue({ ok: false, error: { code: "X", message: "Backlog holds could not be loaded." } });
    rail(load);
    await userEvent.click(screen.getByRole("button", { name: /Backlog/ }));
    expect(await screen.findByTestId("backlog-error")).toHaveTextContent("could not be loaded");
  });

  it("says 'Showing N of M' when New is capped", () => {
    rail(undefined, split({ newTotal: 450, newShown: 300 }));
    expect(screen.getByTestId("holds-new-capped")).toHaveTextContent("Showing 300 of 450 new holds");
  });

  it("has an explicit empty New state and omits Backlog when there is none", () => {
    rail(undefined, split({ newTotal: 0, newShown: 0, backlogTotal: 0 }), []);
    expect(screen.getByText("No new holds.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Backlog holds")).toBeNull();
  });

  it("a failed classification shows 'unavailable', never 'No new holds'", () => {
    rail(undefined, split({ error: "hold classification query failed", newTotal: 0, newShown: 0, backlogTotal: 0 }), []);
    expect(screen.getByTestId("holds-split-unavailable")).toHaveTextContent("hold classification query failed");
    expect(screen.queryByText("No new holds.")).toBeNull();
    expect(screen.queryByLabelText("New holds")).toBeNull();
  });

  it("without a split the rail is the single flat list as before", () => {
    render(<HoldsRail holds={[hold("a", 5)]} labels={new Map()} nowMs={NOW} />);
    expect(screen.queryByLabelText("New holds")).toBeNull();
    expect(screen.getAllByTestId("hold-card")).toHaveLength(1);
  });
});
