import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CoachCallContext, ScriptBundle } from "@biginkc/coach";
import { closrOutbound123Bundle } from "@biginkc/coach/fixtures";
import { getCoachSections } from "@/lib/coach/section-manifest";

import { StaticScriptView } from "./static-script-view";
import type { CallScreenScript, Section } from "./types";

afterEach(cleanup);

const bundle = closrOutbound123Bundle as ScriptBundle;
const context: CoachCallContext = {
  sellerName: "Pat Seller",
  propertyAddress: "123 Main St",
  propertyCounty: null,
  repName: "Jarrad",
  repPhoneE164: "+15555550100",
  motivation: null,
  leadId: "p1",
  sellerPhoneE164: "+15555550101",
  coldCallerName: null,
  yearBuilt: "1990",
  leadSource: null,
  occupancy: null,
};
const script: Section<CallScreenScript> = {
  ok: true,
  data: { ref: { slug: "closr-outbound", revision: 1, digest: "x" }, bundle, context },
};

describe("StaticScriptView", () => {
  it("renders one section per manifest section and a rail link for each", () => {
    render(<StaticScriptView script={script} entryFields={{}} />);
    const sections = getCoachSections(bundle);
    expect(sections.length).toBeGreaterThan(0);
    for (const s of sections) expect(screen.getByTestId(`script-section-${s.id}`)).toBeTruthy();
    expect(within(screen.getByTestId("script-section-rail")).getAllByRole("link")).toHaveLength(sections.length);
  });

  it("renders the seller first name as a resolved token", () => {
    render(<StaticScriptView script={script} entryFields={{}} />);
    expect(screen.getAllByTestId("token-resolved").some((n) => n.textContent === "Pat")).toBe(true);
  });

  it("shows a missing placeholder for an unset entry token and the value once set", () => {
    const { rerender } = render(<StaticScriptView script={script} entryFields={{}} />);
    expect(screen.getAllByTestId("token-placeholder").some((n) => n.textContent?.startsWith("missing"))).toBe(true);
    expect(screen.queryByText("$150,000")).toBeNull();
    rerender(<StaticScriptView script={script} entryFields={{ offer_price: "$150,000" }} />);
    expect(screen.getAllByText("$150,000").length).toBeGreaterThan(0);
  });

  it("makes entry tokens editable and commits through onEntryFieldChange", () => {
    const onChange = vi.fn();
    render(<StaticScriptView script={script} entryFields={{}} onEntryFieldChange={onChange} />);
    const chip = screen.getAllByTestId("token-entry").find((n) => n.getAttribute("data-token") === "offer_price");
    expect(chip).toBeTruthy();
    fireEvent.click(chip!);
    const input = screen.getByTestId("token-entry-input");
    fireEvent.change(input, { target: { value: "$99,000" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("offer_price", "$99,000");
  });

  it("renders the message when the script is unavailable", () => {
    render(<StaticScriptView script={{ ok: false, message: "No script bound" }} entryFields={{}} />);
    expect(screen.getByText("Script unavailable")).toBeTruthy();
    expect(screen.getByText("No script bound")).toBeTruthy();
  });

  it("renders say lines bold", () => {
    const { container } = render(<StaticScriptView script={script} entryFields={{}} />);
    expect(container.querySelectorAll("p.font-bold").length).toBeGreaterThan(0);
  });
});
