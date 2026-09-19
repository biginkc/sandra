import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type {
  CalculatorLead,
  CalculatorSnapshot,
  SaveCalculationInput,
} from "@/lib/calculators/types";
import { EXPENSE_FIELDS, formatDollars, WORKSHEET_SHA256 } from "@/lib/calculators/closr-v1";
import worksheetFixtures from "@/lib/calculators/worksheet-fixtures.json";

import CalculatorClient from "./client";

const lead: CalculatorLead = {
  id: "lead-1",
  address: "4312 Charlotte St, Kansas City, MO",
  seller: "Denise Whitaker",
  status: "Negotiating",
};

function snapshotFrom(input: SaveCalculationInput): CalculatorSnapshot {
  return {
    id: "calculation-1",
    property_id: input.leadId,
    org_id: "org-1",
    series_id: "series-1",
    version: 1,
    parent_id: input.parentId,
    created_at: "2026-09-16T10:00:00.000Z",
    created_by: "user-1",
    formula_version: "closr-worksheet-v1",
    worksheet_sha256: WORKSHEET_SHA256,
    inputs: input.inputs,
    results: {
      commission: 0,
      listing: 0,
      expenses: 0,
      equity: 0,
      family: 0,
      secure: 0,
      rapid: 0,
      arv70: 0,
      investor: 0,
      offers: { fee40000: -40000, fee30000: -30000, fee20000: -20000, fee10000: -10000 },
    },
    decision: input.decision,
    provenance: input.provenance,
  };
}

describe("CalculatorClient", () => {
  it("keeps a standalone worksheet visibly blocked from saving until a lead is attached", () => {
    render(<CalculatorClient initialLead={null} initialSnapshot={null} leadOptions={[lead]} />);

    expect(screen.getByTestId("no-lead-banner")).toHaveTextContent("always saved to a lead");
    expect(screen.getByRole("button", { name: /save to lead/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /attach a lead/i })).toBeEnabled();
  });

  it("labels the itemized expense subtotal and matches the original worksheet fixture", () => {
    const fixture = worksheetFixtures.find((candidate) => candidate.name === "01-original");
    if (!fixture) throw new Error("Missing 01-original worksheet fixture");
    const itemizedExpenses = EXPENSE_FIELDS.reduce(
      (sum, [key]) => sum + (fixture.inputs[key] ?? 0),
      0,
    );

    render(<CalculatorClient initialLead={lead} initialSnapshot={null} />);

    expect(screen.getByText("Itemized expenses")).toBeInTheDocument();
    expect(screen.getByTestId("result-expenses")).toHaveTextContent(formatDollars(itemizedExpenses));
  });

  it("allows the locked listing factor to be edited and relocked without losing the value", async () => {
    const user = userEvent.setup();
    render(<CalculatorClient initialLead={lead} initialSnapshot={null} />);

    const unlock = screen.getByRole("button", { name: /unlock listing percentage/i });
    await user.click(unlock);
    const percentage = screen.getByRole("textbox", { name: "Listing percentage" });
    await user.clear(percentage);
    await user.type(percentage, "85");
    await user.click(screen.getByRole("button", { name: /lock listing percentage/i }));

    expect(screen.getByText("85%")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Listing percentage" })).not.toBeInTheDocument();
  });

  it("preserves an untouched high precision listing factor through blur and retry", async () => {
    const user = userEvent.setup();
    const listingPercentage = 0.29123456789;
    const input: SaveCalculationInput = {
      leadId: lead.id,
      inputs: {
        asIs: 255000,
        listingPercentage,
        profit: 20000,
        flatFee: 150,
        attorney: 995,
        titleInsurance: 500,
        efile: 35,
        recording: 25,
        taxStamps: 200,
        pictures: 300,
        other: 500,
        repairs: 0,
        arv: 350000,
        rehab: 50000,
      },
      decision: {
        approach: "novation",
        program: "equity_protection",
        feeTier: 10000,
        proposedOffer: null,
        terms: "",
        motivation: "",
      },
      provenance: { source: "saved_calculation", leadId: lead.id },
      requestId: "precision-request",
      parentId: null,
    };
    const saved = snapshotFrom(input);
    const saveCalculation = vi
      .fn()
      .mockResolvedValueOnce({ ok: false as const, error: "Temporary save failure" })
      .mockImplementationOnce(async (request: SaveCalculationInput) => ({
        ok: true as const,
        data: snapshotFrom(request),
      }));

    render(<CalculatorClient initialLead={lead} initialSnapshot={saved} saveCalculation={saveCalculation} />);
    await user.click(screen.getByRole("button", { name: /unlock listing percentage/i }));
    const percentage = screen.getByRole("textbox", { name: "Listing percentage" });
    expect(percentage).toHaveValue("29.123456789");
    await user.tab();
    await user.click(screen.getByRole("button", { name: /save to lead/i }));
    await screen.findByRole("button", { name: /retry save/i });
    await user.click(screen.getByRole("button", { name: /retry save/i }));
    await waitFor(() => expect(saveCalculation).toHaveBeenCalledTimes(2));

    const firstRequest = saveCalculation.mock.calls[0]?.[0] as SaveCalculationInput;
    const secondRequest = saveCalculation.mock.calls[1]?.[0] as SaveCalculationInput;
    expect(firstRequest.inputs.listingPercentage).toBe(listingPercentage);
    expect(secondRequest.inputs.listingPercentage).toBe(listingPercentage);
    expect(secondRequest.requestId).toBe(firstRequest.requestId);
  });

  it("preserves decimal and negative text while typing, then validates incomplete input on blur", async () => {
    const user = userEvent.setup();
    render(<CalculatorClient initialLead={lead} initialSnapshot={null} />);

    const asIs = screen.getByRole("textbox", { name: "As-is market value" });
    await user.type(asIs, "123.45");
    expect(asIs).toHaveValue("123.45");

    const rehab = screen.getByRole("textbox", { name: "Investor rehab" });
    await user.type(rehab, "-100");
    expect(rehab).toHaveValue("-100");

    await user.click(screen.getByRole("button", { name: /unlock listing percentage/i }));
    const listing = screen.getByRole("textbox", { name: "Listing percentage" });
    await user.clear(listing);
    await user.type(listing, "93.75");
    expect(listing).toHaveValue("93.75");

    await user.clear(asIs);
    await user.type(asIs, "-");
    expect(asIs).toHaveValue("-");
    await user.tab();
    expect(asIs).toHaveValue("-");
    expect(screen.getByRole("alert")).toHaveTextContent(/rehab:.*nonnegative/i);
  });

  it("rejects out-of-range inputs before a save request is sent", async () => {
    const user = userEvent.setup();
    const saveCalculation = vi.fn();
    render(<CalculatorClient initialLead={lead} initialSnapshot={null} saveCalculation={saveCalculation} />);

    await user.click(screen.getByRole("button", { name: /unlock listing percentage/i }));
    const listing = screen.getByRole("textbox", { name: "Listing percentage" });
    await user.clear(listing);
    await user.type(listing, "105");
    await user.tab();
    expect(listing).toHaveValue("105");
    expect(screen.getByRole("alert")).toHaveTextContent(/listing percentage:.*between 0% and 100%/i);

    const asIs = screen.getByRole("textbox", { name: "As-is market value" });
    await user.type(asIs, "-1");
    await user.tab();
    expect(asIs).toHaveValue("-1");
    expect(asIs).toHaveAttribute("aria-invalid", "true");
    await user.click(screen.getByRole("button", { name: /save to lead/i }));
    await user.click(screen.getByRole("button", { name: /retry save/i }));
    expect(saveCalculation).not.toHaveBeenCalled();

    await user.clear(listing);
    await user.type(listing, "95");
    await user.clear(asIs);
    await user.type(asIs, "100");
    await user.tab();
    await user.click(screen.getByRole("button", { name: /save to lead/i }));
    await waitFor(() => expect(saveCalculation).toHaveBeenCalledOnce());
  });

  it("searches and attaches a lead, then preserves the same request id for a failed save retry", async () => {
    const user = userEvent.setup();
    const searchLeads = vi.fn(async () => ({ ok: true as const, data: [lead] }));
    const saveCalculation = vi
      .fn()
      .mockResolvedValueOnce({ ok: false as const, error: "Temporary save failure" })
      .mockImplementationOnce(async (input: SaveCalculationInput) => ({
        ok: true as const,
        data: snapshotFrom(input),
      }));

    render(
      <CalculatorClient
        initialLead={null}
        initialSnapshot={null}
        searchLeads={searchLeads}
        saveCalculation={saveCalculation}
      />,
    );

    await user.click(screen.getByRole("button", { name: /attach a lead/i }));
    await user.type(screen.getByRole("textbox", { name: /search leads/i }), "Charlotte");
    await waitFor(() => expect(searchLeads).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: /4312 charlotte/i }));

    await user.click(screen.getByRole("button", { name: /save to lead/i }));
    await screen.findByRole("button", { name: /retry save/i });
    await user.click(screen.getByRole("button", { name: /retry save/i }));

    await waitFor(() => expect(saveCalculation).toHaveBeenCalledTimes(2));
    const firstRequest = saveCalculation.mock.calls[0]?.[0] as SaveCalculationInput;
    const secondRequest = saveCalculation.mock.calls[1]?.[0] as SaveCalculationInput;
    expect(secondRequest.requestId).toBe(firstRequest.requestId);
    expect(screen.getAllByRole("status")[0]).toHaveTextContent(/saved revision v1/i);
  });

  it("restores saved results until an input changes and opens the Guide drawer", async () => {
    const user = userEvent.setup();
    const input: SaveCalculationInput = {
      leadId: lead.id,
      inputs: {
        asIs: 255000,
        listingPercentage: 0.9,
        profit: 20000,
        flatFee: 150,
        attorney: 995,
        titleInsurance: 500,
        efile: 35,
        recording: 25,
        taxStamps: 200,
        pictures: 300,
        other: 500,
        repairs: 0,
        arv: 350000,
        rehab: 50000,
      },
      decision: {
        approach: "novation",
        program: "equity_protection",
        feeTier: 10000,
        proposedOffer: null,
        terms: "",
        motivation: "",
      },
      provenance: { source: "saved_calculation", leadId: lead.id },
      requestId: "request-1",
      parentId: null,
    };
    const saved = snapshotFrom(input);
    saved.results.listing = 229500;

    render(<CalculatorClient initialLead={lead} initialSnapshot={saved} />);
    expect(screen.getByText("$229,500.00")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /guide/i }));
    expect(screen.getByRole("dialog", { name: /calculator guide/i })).toBeInTheDocument();
    const closeButtons = screen.getAllByRole("button", { name: /close guide/i });
    await user.click(closeButtons[closeButtons.length - 1]);
    expect(screen.queryByRole("dialog", { name: /calculator guide/i })).not.toBeInTheDocument();
  });

  it("starts a new series when saving the same worksheet against a different lead", async () => {
    const user = userEvent.setup();
    const secondLead: CalculatorLead = {
      id: "lead-2",
      address: "7189 Tracy Ave, Kansas City, MO",
      seller: "Marcus Delgado",
      status: "New lead",
    };
    const input: SaveCalculationInput = {
      leadId: lead.id,
      inputs: {
        asIs: 255000,
        listingPercentage: 0.9,
        profit: 20000,
        flatFee: 150,
        attorney: 995,
        titleInsurance: 500,
        efile: 35,
        recording: 25,
        taxStamps: 200,
        pictures: 300,
        other: 500,
        repairs: 0,
        arv: 350000,
        rehab: 50000,
      },
      decision: {
        approach: "novation",
        program: "equity_protection",
        feeTier: 10000,
        proposedOffer: null,
        terms: "",
        motivation: "",
      },
      provenance: { source: "saved_calculation", leadId: lead.id },
      requestId: "request-old",
      parentId: null,
    };
    const saved = snapshotFrom(input);
    const saveCalculation = vi.fn(async (request: SaveCalculationInput) => ({
      ok: true as const,
      data: { ...snapshotFrom(request), id: "calculation-new", version: 1, property_id: request.leadId },
    }));

    render(<CalculatorClient initialLead={lead} initialSnapshot={saved} leadOptions={[secondLead]} saveCalculation={saveCalculation} />);
    await user.click(screen.getByRole("button", { name: "Change" }));
    await user.click(screen.getByRole("button", { name: /7189 tracy/i }));
    await user.click(screen.getByRole("button", { name: /save to lead/i }));
    await waitFor(() => expect(saveCalculation).toHaveBeenCalledOnce());
    expect(saveCalculation.mock.calls[0]?.[0].leadId).toBe(secondLead.id);
    expect(saveCalculation.mock.calls[0]?.[0].parentId).toBeNull();
  });

  it("fences the worksheet while a save is pending so a late response cannot rewind edits", async () => {
    const user = userEvent.setup();
    let resolveSave: ((value: { ok: true; data: CalculatorSnapshot }) => void) | undefined;
    const saveCalculation = vi.fn(
      () => new Promise<{ ok: true; data: CalculatorSnapshot }>((resolve) => { resolveSave = resolve; }),
    );

    render(<CalculatorClient initialLead={lead} initialSnapshot={null} saveCalculation={saveCalculation} />);
    const asIs = screen.getByLabelText("As-is market value");
    await user.type(asIs, "255000");
    await user.click(screen.getByRole("button", { name: /save to lead/i }));

    expect(asIs).toBeDisabled();
    expect(screen.getByRole("button", { name: "Change" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /saving/i })).toBeDisabled();

    const calls = saveCalculation.mock.calls as unknown as Array<[SaveCalculationInput]>;
    const request = calls[0]?.[0] as SaveCalculationInput;
    resolveSave?.({ ok: true, data: snapshotFrom(request) });
    await waitFor(() => expect(screen.getByText(/saved revision v1/i)).toBeInTheDocument());
    expect(asIs).toHaveValue("255000");
  });
});
