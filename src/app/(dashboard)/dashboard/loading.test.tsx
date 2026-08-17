import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import DashboardLoading from "./loading";

describe("<DashboardLoading />", () => {
  it("announces a truthful Overview loading state", () => {
    render(<DashboardLoading />);

    const loading = screen.getByLabelText("Loading Overview");
    expect(loading).toHaveAttribute("aria-busy", "true");
    expect(loading.querySelectorAll('[data-slot="skeleton"]')).not.toHaveLength(0);
  });
});
