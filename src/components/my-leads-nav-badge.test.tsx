import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MyLeadsNavBadge } from "./my-leads-nav-badge";

describe("MyLeadsNavBadge", () => {
  beforeEach(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refreshes on foreground focus at most once per minute", async () => {
    const onRefresh = vi.fn(async () => ({ ok: true as const, count: 8 }));
    render(<MyLeadsNavBadge initialCount={2} onRefresh={onRefresh} />);

    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledOnce());
    expect(screen.getByTestId("my-leads-badge")).toHaveTextContent("8");

    window.dispatchEvent(new Event("focus"));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("keeps the last confirmed count when a refresh fails", async () => {
    const onRefresh = vi.fn(async () => ({ ok: false as const }));
    render(<MyLeadsNavBadge initialCount={4} onRefresh={onRefresh} />);

    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledOnce());
    expect(screen.getByTestId("my-leads-badge")).toHaveTextContent("4");
  });
});
