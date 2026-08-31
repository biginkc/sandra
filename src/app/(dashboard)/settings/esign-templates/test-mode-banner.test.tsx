import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TestModeBanner } from "./test-mode-banner";

describe("TestModeBanner", () => {
  it("uses the canonical amber pill treatment without primary navy tokens", () => {
    render(<TestModeBanner />);
    const pill = screen.getByText("TEST MODE");

    expect(pill).toHaveClass(
      "border-alert-warning/60",
      "bg-alert-warning/15",
      "text-alert-warning",
    );
    expect(pill).not.toHaveClass("bg-primary", "text-primary-foreground");
  });
});
