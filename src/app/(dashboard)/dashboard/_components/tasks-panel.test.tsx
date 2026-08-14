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
  // Plain spread (not `??`) so an explicit `null` override — e.g.
  // property_id: null for a personal-block row — isn't clobbered back to
  // the default the way `??` would treat it as "unset".
  return {
    type: "follow_up",
    title: "Follow up on 123 Main",
    due_at: new Date().toISOString(),
    property_id: "prop-1",
    contact_id: null,
    address: "123 Main St",
    city: "Kansas City",
    state: "MO",
    ...overrides,
  };
}

describe("<TasksPanel />", () => {
  it("renders the all-clear empty state when all buckets are empty", () => {
    render(<TasksPanel overdue={[]} today={[]} upcoming={[]} />);
    expect(screen.getByText("My Tasks")).toBeInTheDocument();
    expect(screen.getByText(/all caught up/i)).toBeInTheDocument();
    expect(screen.queryByTestId("tasks-panel")).not.toBeInTheDocument();
  });

  it("renders today bucket with row count badge", () => {
    const today = [
      makeRow({ id: "t1", address: "111 First St" }),
      makeRow({ id: "t2", address: "222 Second Ave", type: "callback" }),
    ];
    render(<TasksPanel overdue={[]} today={today} upcoming={[]} />);

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

  it("renders all three buckets with separate section headers", () => {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    render(
      <TasksPanel
        overdue={[
          makeRow({ id: "t0", address: "000 Yesterday Rd", due_at: yesterday }),
        ]}
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

    expect(screen.getByText("Overdue")).toBeInTheDocument();
    expect(screen.getByText("Today")).toBeInTheDocument();
    expect(screen.getByText("Upcoming")).toBeInTheDocument();
    expect(screen.getByText("000 Yesterday Rd")).toBeInTheDocument();
    expect(screen.getByText("111 Today Way")).toBeInTheDocument();
    expect(screen.getByText("222 Tomorrow Lane")).toBeInTheDocument();

    // count badge = 3 (1 overdue + 1 today + 1 upcoming)
    expect(screen.getByText("3", { selector: "span" })).toBeInTheDocument();
  });

  it("renders the overdue section on its own with the critical-alert label", () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    render(
      <TasksPanel
        overdue={[
          makeRow({ id: "t0", address: "000 Yesterday Rd", due_at: yesterday }),
        ]}
        today={[]}
        upcoming={[]}
      />,
    );

    const label = screen.getByText("Overdue");
    expect(label).toBeInTheDocument();
    expect(label.className).toContain("text-alert-critical");
    expect(screen.getByText(/Follow-up · overdue/)).toBeInTheDocument();
  });

  it("each row links to the property's messages thread", () => {
    const today = [makeRow({ id: "t1", property_id: "prop-abc" })];
    const { container } = render(
      <TasksPanel overdue={[]} today={today} upcoming={[]} />,
    );

    const link = container.querySelector(
      "a[href='/messages?property_id=prop-abc']",
    );
    expect(link).not.toBeNull();
  });

  it("renders a personal block with no property or contact as unlinked", () => {
    const today = [
      makeRow({
        id: "t1",
        // A fully-unlinked row is necessarily an appointment — the DB's
        // linkage CHECK forbids unlinked non-appointment tasks, and only
        // appointments ever render the "Personal block" label.
        type: "appointment",
        title: "Block 2pm–3pm",
        property_id: null,
        contact_id: null,
        address: null,
        city: null,
        state: null,
      }),
    ];
    render(<TasksPanel overdue={[]} today={today} upcoming={[]} />);

    expect(screen.getByText("Personal block")).toBeInTheDocument();
    const wrapper = screen.getByTestId("task-row-t1-unlinked");
    expect(wrapper.tagName).toBe("DIV");
    expect(wrapper.querySelector("a")).toBeNull();
  });

  it("links a contact-only row (no property) to the Messages thread", () => {
    const today = [
      makeRow({
        id: "t1",
        title: "Call the owner",
        property_id: null,
        contact_id: "contact-abc",
        address: null,
        city: null,
        state: null,
      }),
    ];
    const { container } = render(
      <TasksPanel overdue={[]} today={today} upcoming={[]} />,
    );

    expect(screen.getByText("Call the owner")).toBeInTheDocument();
    const link = container.querySelector(
      "a[href='/messages?thread=contact-abc']",
    );
    expect(link).not.toBeNull();
  });

  it("each row exposes Done and Snooze action buttons", () => {
    const today = [makeRow({ id: "t1" })];
    render(<TasksPanel overdue={[]} today={today} upcoming={[]} />);

    expect(screen.getByTestId("task-done-t1")).toBeInTheDocument();
    expect(screen.getByTestId("task-snooze-t1")).toBeInTheDocument();
  });
});
