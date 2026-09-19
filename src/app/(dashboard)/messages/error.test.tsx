import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { reportError } from "@/lib/errors/report";
import MessagesError from "./error";

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

describe("<MessagesError />", () => {
  it("distinguishes route failure from empty data and offers Retry", () => {
    const reset = vi.fn();

    render(<MessagesError error={new Error("query failed")} reset={reset} />);

    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "query failed" }),
      { tags: { operation: "messages_route_render", surface: "messages_page" } },
    );

    expect(screen.getByTestId("messages-load-failure")).toHaveTextContent(
      "This is a load failure, not an empty Inbox or Outbox",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
