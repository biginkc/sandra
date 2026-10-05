import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { formatDollars } from "@/lib/calculators/closr-v1";
import { ARV_ANCHOR_KEYS, computeAnchors } from "@/lib/comps/anchors";

import { NumbersCard } from "./numbers-card";
import type { CallScreenComps, LeadCompPublic, Section } from "./types";

afterEach(cleanup);

function latest(over: Partial<LeadCompPublic> = {}): LeadCompPublic {
  return {
    id: "c1",
    org_id: "o1",
    property_id: "p1",
    provider: "attom",
    request_id: null,
    fetched_at: "2026-10-01T00:00:00Z",
    as_is_value: 250000,
    as_is_low: 230000,
    as_is_high: 270000,
    confidence: "high",
    confidence_score: 90,
    verify_first: false,
    verify_reasons: [],
    arv_estimate: null,
    arv_method: "none",
    comps: [
      { address: "1 A St", saleDate: "2026-01-01", salePrice: 240000, sqft: 1200, beds: 3, baths: 2, yearBuilt: 1990, distanceMiles: 0.4, providerId: null, renovatedHint: null },
    ],
    owner_of_record: "Pat Seller",
    legal_description: "Lot 1",
    legal_description_complete: true,
    provider_property_id: null,
    ...over,
  } as LeadCompPublic;
}

function comps(over: Partial<CallScreenComps> = {}): Section<CallScreenComps> {
  return {
    ok: true,
    data: {
      latest: latest(),
      request: null,
      settings: { enabled: true, capped: false },
      valuation: { arv: null, rehab: null },
      ...over,
    },
  };
}

const base = { propertyId: "p1", isTraining: false };

describe("NumbersCard", () => {
  it("suppresses ARV anchors without ARV and never prints $0", () => {
    const { container } = render(<NumbersCard {...base} comps={comps()} />);
    expect(screen.getByTestId("numbers-arv-anchors").textContent).toContain("unavailable: needs ARV and rehab");
    expect(container.textContent).not.toContain("$0");
    expect(screen.getByTestId("numbers-as-is-anchors").textContent).toContain("$");
    expect(container.textContent).toContain(formatDollars(250000));
  });

  it("shows verify-first only when flagged", () => {
    const { rerender } = render(<NumbersCard {...base} comps={comps({ latest: latest({ verify_first: true, verify_reasons: ["few_comps"] }) })} />);
    expect(screen.getByTestId("numbers-verify-first")).toBeTruthy();
    rerender(<NumbersCard {...base} comps={comps({ latest: latest({ verify_first: false }) })} />);
    expect(screen.queryByTestId("numbers-verify-first")).toBeNull();
  });

  it("handles no latest comp", () => {
    const { container } = render(<NumbersCard {...base} comps={comps({ latest: null })} />);
    expect(screen.getByText("No comps yet")).toBeTruthy();
    expect(screen.queryByTestId("numbers-verify-first")).toBeNull();
    expect(container.textContent).not.toContain("$0");
  });

  it("renders ARV anchors when ARV and rehab are typed", () => {
    render(<NumbersCard {...base} comps={comps({ valuation: { arv: 300000, rehab: 20000 } })} />);
    const expected = computeAnchors({ asIs: 250000, arv: 300000, rehab: 20000, verifyFirst: false });
    const text = screen.getByTestId("numbers-arv-anchors").textContent ?? "";
    expect(text).not.toContain("unavailable");
    for (const k of ARV_ANCHOR_KEYS) {
      const a = expected.arvDependent[k];
      if (a.status === "ok") expect(text).toContain(formatDollars(a.value));
    }
  });

  it("shows the fixture ribbon only for fixture data", () => {
    const { rerender } = render(<NumbersCard {...base} comps={comps({ latest: latest({ provider: "fixture" }) })} />);
    expect(screen.getByTestId("numbers-fixture-ribbon").textContent).toBe("Fixture data");
    rerender(<NumbersCard {...base} comps={comps({ latest: latest({ provider: "attom" }) })} />);
    expect(screen.queryByTestId("numbers-fixture-ribbon")).toBeNull();
  });

  it("still renders when comps failed to load", () => {
    render(<NumbersCard {...base} comps={{ ok: false, message: "Comps lookup broke" }} />);
    expect(screen.getByTestId("numbers-card")).toBeTruthy();
    expect(screen.getByText("Numbers unavailable")).toBeTruthy();
    expect(screen.getByText("Comps lookup broke")).toBeTruthy();
  });

  it("shows pending for queued requests", () => {
    render(<NumbersCard {...base} comps={comps({ request: { status: "queued", trigger: "manual" } })} />);
    expect(screen.getByText("comps pending")).toBeTruthy();
  });

  it.each([
    ["no_match", "No matching property found"],
    ["error", "Last comp fetch failed"],
    ["cancelled", "Comp request cancelled"],
    ["capped", "Monthly comp cap reached"],
  ])("explains request status %s", (status, text) => {
    render(<NumbersCard {...base} comps={comps({ request: { status, trigger: "manual" } })} />);
    expect(screen.getByText(text)).toBeTruthy();
  });

  it("disables the comp button for training leads", () => {
    render(<NumbersCard {...base} isTraining comps={comps()} onCompLead={vi.fn()} />);
    expect((screen.getByTestId("comp-this-lead-p1") as HTMLButtonElement).disabled).toBe(true);
  });

  it("reports ready and refreshes", async () => {
    const onCompsChanged = vi.fn();
    const onCompLead = vi.fn().mockResolvedValue({ ok: true, result: { status: "ready", compId: "c", cached: false } });
    render(<NumbersCard {...base} comps={comps()} onCompLead={onCompLead} onCompsChanged={onCompsChanged} />);
    fireEvent.click(screen.getByTestId("comp-this-lead-p1"));
    await waitFor(() => expect(screen.getByText("Comps updated")).toBeTruthy());
    expect(onCompsChanged).toHaveBeenCalledTimes(1);
  });

  it("reports no_match", async () => {
    const onCompLead = vi.fn().mockResolvedValue({ ok: true, result: { status: "no_match" } });
    render(<NumbersCard {...base} comps={comps()} onCompLead={onCompLead} />);
    fireEvent.click(screen.getByTestId("comp-this-lead-p1"));
    await waitFor(() => expect(screen.getByText("No matching property found")).toBeTruthy());
  });

  it("reports BACKOFF and other error codes", async () => {
    const onCompLead = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, result: { status: "error", code: "BACKOFF" } })
      .mockResolvedValueOnce({ ok: true, result: { status: "error", code: "TIMEOUT" } });
    render(<NumbersCard {...base} comps={comps()} onCompLead={onCompLead} />);
    fireEvent.click(screen.getByTestId("comp-this-lead-p1"));
    await waitFor(() => expect(screen.getByText("Comps paused after a recent provider error. Try again later.")).toBeTruthy());
    fireEvent.click(screen.getByTestId("comp-this-lead-p1"));
    await waitFor(() => expect(screen.getByText("Comps request failed (TIMEOUT)")).toBeTruthy());
  });

  it("shows the action failure message", async () => {
    const onCompLead = vi.fn().mockResolvedValue({ ok: false, message: "Not allowed" });
    render(<NumbersCard {...base} comps={comps()} onCompLead={onCompLead} />);
    fireEvent.click(screen.getByTestId("comp-this-lead-p1"));
    await waitFor(() => expect(screen.getByText("Not allowed")).toBeTruthy());
  });

  it("rejects negative valuation input", async () => {
    const onSave = vi.fn();
    render(<NumbersCard {...base} comps={comps()} onSaveValuation={onSave} />);
    fireEvent.change(screen.getByTestId("numbers-rehab"), { target: { value: "-5" } });
    fireEvent.click(screen.getByTestId("numbers-save"));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeTruthy();
  });
});
