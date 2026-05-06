import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { TaskRow } from "../queries";

import { TasksPanel } from "./tasks-panel";

// Server-action import in TaskActionsRow pulls in next/cache; stub.
vi.mock("../../tasks/actions", () => ({
  completeTaskAction: vi.fn(),
  snoozeTaskAction: vi.fn(),
  reassignTaskAction: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

function makeRow(overrides: Partial<TaskRow> & { id: string }): TaskRow {
  return {
    id: overrides.id,
    type: overrides.type ?? "follow_up",
    title: overrides.title ?? "Follow up on 123 Main",
    due_at: overrides.due_at ?? new Date().toISOString(),
    property_id: overrides.property_id ?? "prop-1",
    address: overrides.address ?? "123 Main St",
    city: overrides.city ?? "Kansas City",
    state: overrides.state ?? "MO",
  };
}

describe("<TasksPanel />", () => {
  it("renders the all-clear empty state when both buckets are empty", () => {
    render(<TasksPanel today={[]} upcoming={[]} />);
    expect(screen.getByText("My Tasks")).toBeInTheDocument();
    expect(screen.getByText(/all caught up/i)).toBeInTheDocument();
    expect(screen.queryByTestId("tasks-panel")).not.toBeInTheDocument();
  });

  it("renders today bucket with row count badge", () => {
    const today = [
      makeRow({ id: "t1", address: "111 First St" }),
      makeRow({ id: "t2", address: "222 Second Ave", type: "callback" }),
    ];
    render(<TasksPanel today={today} upcoming={[]} />);

    expect(screen.getByTestId("tasks-panel")).toBeInTheDocument();
    expect(screen.getByText("Today")).toBeInTheDocument();
    expect(screen.getByText("111 First St")).toBeInTheDocument();
    expect(screen.getByText("222 Second Ave")).toBeInTheDocument();

    // The Callback row uses the Callback type label
    expect(screen.getByText(/Callback · today/)).toBeInTheDocument();
    // The Follow-up row uses the Follow-up label
    expect(screen.getByText(/Follow-up · today/)).toBeInTheDocument();

    // count badge = 2
    const badge = screen.getByText("2", { selector: "span" });
    expect(badge).toBeInTheDocument();
  });

  it("renders both buckets with separate section headers", () => {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    render(
      <TasksPanel
        today={[makeRow({ id: "t1", address: "111 Today Way" })]}
        upcoming={[
          makeRow({
            id: "t2",
            address: "222 Tomorrow Lane",
            due_at: tomorrow,
          }),
        ]}
      />,
    );

    expect(screen.getByText("Today")).toBeInTheDocument();
    expect(screen.getByText("Upcoming")).toBeInTheDocument();
    expect(screen.getByText("111 Today Way")).toBeInTheDocument();
    expect(screen.getByText("222 Tomorrow Lane")).toBeInTheDocument();

    // count badge = 2 (1 today + 1 upcoming)
    expect(screen.getByText("2", { selector: "span" })).toBeInTheDocument();
  });

  it("each row links to the property's messages thread", () => {
    const today = [makeRow({ id: "t1", property_id: "prop-abc" })];
    const { container } = render(
      <TasksPanel today={today} upcoming={[]} />,
    );

    const link = container.querySelector(
      "a[href='/messages?property_id=prop-abc']",
    );
    expect(link).not.toBeNull();
  });

  it("each row exposes Done and Snooze action buttons", () => {
    const today = [makeRow({ id: "t1" })];
    render(<TasksPanel today={today} upcoming={[]} />);

    expect(screen.getByTestId("task-done-t1")).toBeInTheDocument();
    expect(screen.getByTestId("task-snooze-t1")).toBeInTheDocument();
  });
});
