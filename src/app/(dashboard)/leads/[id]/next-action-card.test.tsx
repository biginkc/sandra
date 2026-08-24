import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { completeTaskAction, snoozeTaskAction, refreshMock } = vi.hoisted(
  () => ({
    completeTaskAction: vi.fn(),
    snoozeTaskAction: vi.fn(),
    refreshMock: vi.fn(),
  }),
);

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

vi.mock("../../tasks/actions", () => ({
  completeTaskAction,
  snoozeTaskAction,
}));

import { NextActionCard } from "./next-action-card";

const task = {
  id: "task-1",
  title: "Call homeowner",
  due_at: "2026-08-19T15:00:00.000Z",
  type: "callback",
};

describe("<NextActionCard />", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    completeTaskAction.mockResolvedValue({ ok: true, data: task });
  });

  it("shows the nearest dated task with current Done and Snooze controls", () => {
    render(<NextActionCard task={task} timezone="America/Chicago" />);
    expect(screen.getByTestId("lead-next-action")).toHaveTextContent(
      "Call homeowner",
    );
    expect(screen.getByRole("button", { name: /Done/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Snooze/ })).toBeInTheDocument();
  });

  it("shows No next action when no dated work is open", () => {
    render(<NextActionCard task={null} timezone="America/Chicago" />);
    expect(screen.getByTestId("lead-no-next-action")).toHaveTextContent(
      "No next action",
    );
    expect(screen.getByRole("link", { name: "Set one" })).toHaveAttribute(
      "href",
      "#set-next-action",
    );
  });

  it("uses the compact inline-chip treatment in the working-state bar", () => {
    const { rerender } = render(
      <NextActionCard task={null} timezone="America/Chicago" compact />,
    );
    expect(screen.getByTestId("lead-no-next-action")).toHaveClass(
      "inline-flex",
      "rounded-full",
    );
    expect(screen.getByRole("link", { name: "Set one" })).toHaveClass(
      "min-h-9",
      "sm:min-h-6",
    );

    rerender(
      <NextActionCard task={task} timezone="America/Chicago" compact />,
    );
    expect(screen.getByTestId("lead-next-action")).toHaveClass(
      "inline-flex",
      "rounded-full",
    );
    expect(screen.getByTestId("lead-next-action")).toHaveTextContent(
      "Next: Call homeowner",
    );
  });

  it("shows the nearest appointment with its time and links to appointment controls", () => {
    render(
      <NextActionCard
        task={{
          id: "appointment-1",
          title: "Property walkthrough",
          due_at: "2026-08-19T14:00:00.000Z",
          type: "appointment",
        }}
        timezone="America/Chicago"
      />,
    );

    expect(screen.getByTestId("lead-next-action")).toHaveTextContent(
      "Property walkthrough",
    );
    expect(
      screen.getByRole("link", { name: "View appointment" }),
    ).toHaveAttribute("href", "#lead-appointments");
    expect(screen.queryByRole("button", { name: /Done/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Snooze/ })).toBeNull();
  });

  it("keeps a failed task mutation visible and safely retryable", async () => {
    const user = userEvent.setup();
    completeTaskAction
      .mockResolvedValueOnce({
        ok: false,
        error: { message: "network unavailable" },
      })
      .mockResolvedValueOnce({ ok: true, data: task });

    render(<NextActionCard task={task} timezone="America/Chicago" />);
    await user.click(screen.getByRole("button", { name: /Done/ }));
    expect(
      await screen.findByTestId("lead-next-action-failure"),
    ).toHaveTextContent("network unavailable");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(completeTaskAction).toHaveBeenCalledTimes(2);
    expect(completeTaskAction).toHaveBeenNthCalledWith(1, "task-1");
    expect(completeTaskAction).toHaveBeenNthCalledWith(2, "task-1");
    expect(refreshMock).toHaveBeenCalled();
  });

  it("never retargets a failed retry operation to newer task props", async () => {
    const user = userEvent.setup();
    completeTaskAction.mockResolvedValue({
      ok: false,
      error: { message: "network unavailable" },
    });

    const view = render(
      <NextActionCard task={task} timezone="America/Chicago" />,
    );
    await user.click(screen.getByRole("button", { name: /Done/ }));
    expect(await screen.findByRole("button", { name: "Retry" })).toBeVisible();

    const newerTask = { ...task, id: "task-2", title: "Call agent" };
    view.rerender(
      <NextActionCard task={newerTask} timezone="America/Chicago" />,
    );

    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    await user.click(screen.getByRole("button", { name: /Done/ }));
    expect(completeTaskAction).toHaveBeenNthCalledWith(1, "task-1");
    expect(completeTaskAction).toHaveBeenNthCalledWith(2, "task-2");
  });
});
