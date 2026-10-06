import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderDataView } from "./provider-data-view";

afterEach(cleanup);
describe("ProviderDataView", () => {
  it("shows actual returned records with undisclosed prices, identity, and search limits", () => {
    const {container} = render(<ProviderDataView data={{facts:[{label:"ATTOM address",value:"100 Sample St"}],search:"Within 5 miles; sales in the last 24 months",salesStatus:"ok",sales:[{address:"626 Sample Ave",saleDate:"2025-10-21",salePrice:null,sqft:1200,beds:2,baths:1.5,yearBuilt:1962,distanceMiles:0.3644,providerId:"1",renovatedHint:null}]}} />);
    expect(screen.getByText("Not disclosed")).toBeTruthy();
    expect(screen.getByText("626 Sample Ave")).toBeTruthy();
    expect(screen.getByText("100 Sample St")).toBeTruthy();
    expect(screen.getByText("0.36 mi")).toBeTruthy();
    expect(container.textContent).not.toContain("$0");
    expect(container.textContent).toContain("last 24 months");
  });
  it("distinguishes no matching criteria from missing entitlement and unmapped data", () => {
    const base = {facts:[],sales:[],search:null};
    const {rerender} = render(<ProviderDataView data={{...base,salesStatus:"minimum_not_met"}} />);
    expect(screen.getByTestId("attom-sales-status").textContent).toContain("minimum number");
    rerender(<ProviderDataView data={{...base,salesStatus:"not_entitled"}} />);
    expect(screen.getByTestId("attom-sales-status").textContent).toContain("does not have access");
    rerender(<ProviderDataView data={{...base,salesStatus:"unmapped"}} />);
    expect(screen.getByTestId("attom-sales-status").textContent).toContain("not verified");
  });
});
