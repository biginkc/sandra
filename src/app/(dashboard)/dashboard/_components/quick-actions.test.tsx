import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { QuickActions } from "./quick-actions";

describe("<QuickActions />", () => {
  it("sends admins to the sequence authoring flow", () => {
    render(<QuickActions isAdmin />);

    const action = screen.getByRole("link", { name: /start a sequence/i });
    expect(action).toHaveAttribute("href", "/sequences/new");
  });

  it("does not show non-admins a sequence authoring shortcut", () => {
    render(<QuickActions isAdmin={false} />);

    expect(
      screen.queryByRole("link", { name: /start a sequence/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /view sequences/i })).toHaveAttribute(
      "href",
      "/sequences",
    );
  });
});
