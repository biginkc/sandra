import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ScorecardCard } from "./scorecard-card";
import type { Sample, ScorecardRow } from "./scorecard";

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ rpc: vi.fn() }),
}));

const batch = (c: number, n: number, agreed: number): Sample[] =>
  Array.from({ length: n }, (_, i) => [c, i < agreed ? 1 : 0] as Sample);

const row = (
  outcome: string,
  over: Partial<ScorecardRow> = {},
): ScorecardRow => ({
  outcome,
  runs: 0,
  auto_applied: 0,
  held: 0,
  auto_settled: 0,
  auto_agreed: 0,
  held_decided: 0,
  held_agreed: 0,
  threshold: null,
  automation_enabled: null,
  samples: [],
  ...over,
});

const ROWS: ScorecardRow[] = [
  row("nurture", {
    runs: 80,
    auto_applied: 60,
    held: 20,
    auto_settled: 50,
    auto_agreed: 47,
    held_decided: 10,
    held_agreed: 7,
    threshold: 0.9,
    automation_enabled: true,
    samples: [
      ...batch(0.7, 20, 10),
      ...batch(0.9, 30, 28),
      ...batch(0.95, 40, 40),
    ],
  }),
  row("new_lead", {
    runs: 12,
    held: 12,
    threshold: 0.95,
    automation_enabled: false,
    samples: batch(0.9, 12, 12),
  }),
];

const section = (name: string) => screen.getByTestId(`scorecard-${name}`);

let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("ScorecardCard", () => {
  it("renders per-outcome counts, agreement, threshold and automation state", () => {
    render(<ScorecardCard orgId="o" initialRows={ROWS} load={vi.fn()} />);
    const nurture = within(section("nurture"));
    expect(nurture.getByText(/80 runs/)).toBeInTheDocument();
    expect(nurture.getByText(/60 auto/)).toBeInTheDocument();
    expect(nurture.getByText(/20 held/)).toBeInTheDocument();
    expect(
      nurture.getByText(/auto agreement/i).parentElement,
    ).toHaveTextContent("94%");
    expect(
      nurture.getByText(/held agreement/i).parentElement,
    ).toHaveTextContent("70%");
    expect(nurture.getByText(/threshold 0\.900/i)).toBeInTheDocument();
    expect(nurture.getByText(/automation on/i)).toBeInTheDocument();
    expect(
      within(section("new_lead")).getByText(/automation off/i),
    ).toBeInTheDocument();
  });

  it("shows opted_out as always human and not switchable, even if the row says automation is on", () => {
    render(
      <ScorecardCard
        orgId="o"
        initialRows={[row("opted_out", { runs: 5, held: 5, threshold: 0.95, automation_enabled: true, samples: batch(0.9, 5, 5) })]}
        load={vi.fn()}
      />,
    );
    const el = within(section("opted_out"));
    expect(el.getByText(/always human \(locked\)/i)).toBeInTheDocument();
    expect(el.queryByText(/automation on/i)).toBeNull();
  });

  it("shows every outcome even with no data, with n/a rates", () => {
    render(<ScorecardCard orgId="o" initialRows={[]} load={vi.fn()} />);
    for (const o of [
      "new_lead",
      "wrong_number",
      "not_interested",
      "nurture",
      "opted_out",
    ]) {
      expect(section(o)).toBeInTheDocument();
    }
    expect(
      within(section("opted_out")).getAllByText(/n\/a/).length,
    ).toBeGreaterThan(0);
  });

  it("suggests a threshold and copies the exact rule text without applying anything", async () => {
    render(
      <ScorecardCard
        orgId="o"
        initialRows={[{ ...ROWS[0], threshold: 0.85 }, ROWS[1]]}
        load={vi.fn()}
      />,
    );
    const nurture = within(section("nurture"));
    expect(nurture.getByText(/suggested ≥ 0\.900/i)).toBeInTheDocument();
    expect(screen.getByText(/suggestion only/i)).toBeInTheDocument();
    fireEvent.click(
      nurture.getByRole("button", { name: /copy for approval/i }),
    );
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        "nurture: auto-apply at native confidence ≥ 0.900",
      ),
    );
    expect(await nurture.findByText(/copied/i)).toBeInTheDocument();
  });

  it("shows auto and held agreement separately in the suggestion line, and labels loosening", () => {
    const samples = [
      ...Array.from({ length: 30 }, () => [0.8, 1, "h"] as Sample),
      ...Array.from({ length: 30 }, () => [0.97, 1, "a"] as Sample),
    ];
    render(
      <ScorecardCard
        orgId="o"
        initialRows={[row("nurture", { runs: 60, threshold: 0.95, samples })]}
        load={vi.fn()}
      />,
    );
    const el = within(section("nurture"));
    expect(el.getByText(/loosens current/i)).toBeInTheDocument();
    expect(el.getByText(/auto 100% \(n=30\)/i)).toBeInTheDocument();
    expect(el.getByText(/held 100% \(n=30\)/i)).toBeInTheDocument();
    expect(el.getByText(/total n=60/i)).toBeInTheDocument();
  });

  it("hides Copy for approval when the suggestion equals the current threshold", () => {
    render(
      <ScorecardCard
        orgId="o"
        initialRows={[
          row("nurture", { runs: 30, threshold: 0.9, samples: batch(0.9, 30, 30) }),
        ]}
        load={vi.fn()}
      />,
    );
    const el = within(section("nurture"));
    expect(el.getByText(/suggested ≥ 0\.900/i)).toBeInTheDocument();
    expect(el.queryByRole("button", { name: /copy for approval/i })).not.toBeInTheDocument();
  });

  it("keeps the current threshold when only a stray low sample would loosen it", () => {
    const samples: Sample[] = [...batch(0.96, 29, 29), [0.4, 1]];
    render(
      <ScorecardCard
        orgId="o"
        initialRows={[row("nurture", { runs: 30, threshold: 0.95, samples })]}
        load={vi.fn()}
      />,
    );
    const el = within(section("nurture"));
    expect(el.getByText(/keep current threshold/i)).toBeInTheDocument();
    expect(el.queryByRole("button", { name: /copy/i })).not.toBeInTheDocument();
  });

  it("shows the current tail when no cutoff qualifies and the tail is under 95%", () => {
    const samples: Sample[] = [...batch(0.5, 25, 25), ...batch(0.96, 35, 33)];
    render(
      <ScorecardCard
        orgId="o"
        initialRows={[row("nurture", { runs: 60, threshold: 0.95, samples })]}
        load={vi.fn()}
      />,
    );
    const el = within(section("nurture"));
    expect(
      el.getByText(/no qualifying cutoff; current tail at 94\.3% \(n=35\)/i),
    ).toBeInTheDocument();
    expect(el.queryByText(/keep current threshold/i)).not.toBeInTheDocument();
  });

  it("shows insufficient data with no copy button under 30 samples", () => {
    render(<ScorecardCard orgId="o" initialRows={ROWS} load={vi.fn()} />);
    const nl = within(section("new_lead"));
    expect(nl.getByText(/insufficient data \(12\/30\)/i)).toBeInTheDocument();
    expect(nl.queryByRole("button", { name: /copy/i })).not.toBeInTheDocument();
  });

  it("says when no cutoff reaches 95%", () => {
    render(
      <ScorecardCard
        orgId="o"
        initialRows={[
          row("opted_out", { runs: 50, samples: batch(0.9, 50, 40) }),
        ]}
        load={vi.fn()}
      />,
    );
    const el = within(section("opted_out"));
    expect(el.getByText(/no cutoff reaches 95%/i)).toBeInTheDocument();
    expect(el.queryByRole("button", { name: /copy/i })).not.toBeInTheDocument();
  });

  it("defaults to 7d and reloads for 30d on toggle", async () => {
    const load = vi.fn(async () => [row("nurture", { runs: 999 })]);
    render(<ScorecardCard orgId="org-1" initialRows={ROWS} load={load} />);
    expect(screen.getByRole("button", { name: "7d" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "30d" }));
    await waitFor(() => expect(load).toHaveBeenCalledWith("org-1", 30));
    expect(
      await within(section("nurture")).findByText(/999 runs/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "30d" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("polls every 60 seconds", async () => {
    vi.useFakeTimers();
    const load = vi.fn(async () => ROWS);
    render(<ScorecardCard orgId="o" initialRows={ROWS} load={load} />);
    expect(load).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("loads on mount when the server had no data, and shows a degraded state on failure", async () => {
    const load = vi.fn(async () => {
      throw new Error("boom");
    });
    render(<ScorecardCard orgId="o" initialRows={null} load={load} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /scorecard unavailable/i,
    );
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("keeps stale rows and flags a failed refresh", async () => {
    const load = vi.fn(async () => {
      throw new Error("boom");
    });
    render(<ScorecardCard orgId="o" initialRows={ROWS} load={load} />);
    fireEvent.click(screen.getByRole("button", { name: "30d" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /scorecard unavailable/i,
    );
    expect(within(section("nurture")).getByText(/80 runs/)).toBeInTheDocument();
  });
});
