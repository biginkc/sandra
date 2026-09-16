import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PageHeader } from "./page-header";

describe("PageHeader", () => {
  it("keeps title, description, breadcrumbs, context, and actions in one shared structure", () => {
    render(
      <PageHeader
        breadcrumb={[
          { label: "Workspace", href: "/dashboard" },
          { label: "Calculators" },
        ]}
        title="Offer Calculator"
        description="Build an offer for the attached lead."
        context={<span>123 Main Street</span>}
        actions={<button type="button">Save to lead</button>}
      />,
    );

    expect(screen.getByRole("banner")).toHaveClass("gap-2");
    expect(screen.getByRole("heading", { level: 1, name: "Offer Calculator" })).toHaveClass(
      "text-2xl",
      "font-bold",
      "leading-tight",
      "tracking-[-0.02em]",
    );
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent(
      "Workspace/Calculators",
    );
    expect(screen.getByText("Build an offer for the attached lead.")).toHaveClass("text-sm");
    expect(screen.getByText("123 Main Street")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save to lead" })).toBeInTheDocument();
  });
});
