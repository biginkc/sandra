import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AppointmentOutcomeRow,
  AppointmentUpcomingActions,
} from "./appointment-outcome-row";
import {
  cancelAppointmentAction,
  completeAppointmentAction,
} from "./lifecycle-actions";

vi.mock("./lifecycle-actions", () => ({
  cancelAppointmentAction: vi.fn(),
  completeAppointmentAction: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

// Reschedule reuses BookAppointmentPopover — its own internals (calendar,
// select, timezone lookup) are covered by book-appointment-popover.test.tsx.
// Stub it here as a real-enough trigger button that forwards `triggerRef`
// (so AppointmentUpcomingActions' ref-click open mechanism is exercised)
// and exposes the props it was called with for assertions.
vi.mock("./book-appointment-popover", () => ({
  BookAppointmentPopover: (props: {
    taskId?: string;
    assigneeId?: string;
    mode?: string;
    triggerLabel?: string;
    triggerRef?: React.Ref<HTMLButtonElement>;
    triggerTabIndex?: number;
    onOpenChange?: (open: boolean) => void;
  }) => {
    const [opened, setOpened] = React.useState(false);
    return (
      <>
        <button
          ref={props.triggerRef}
          tabIndex={props.triggerTabIndex}
          type="button"
          data-testid={`stub-reschedule-trigger-${props.taskId}`}
          onClick={() => {
            setOpened(true);
            props.onOpenChange?.(true);
          }}
        >
          {props.triggerLabel}
        </button>
        {opened ? (
          <div data-testid={`stub-reschedule-opened-${props.taskId}`}>
            mode={props.mode} assignee={props.assigneeId}
            <button
              type="button"
              data-testid={`stub-reschedule-close-${props.taskId}`}
              onClick={() => {
                setOpened(false);
                props.onOpenChange?.(false);
              }}
            >
              Close reschedule
            </button>
          </div>
        ) : null}
      </>
    );
  },
}));

// Same DropdownMenu mock convention as assign-dropdown.test.tsx: content
// renders unconditionally so tests don't need to model base-ui's open
// state / portal behavior.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuTrigger: ({ render }: { render: React.ReactNode }) => render,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    disabled,
    onClick,
    ...props
  }: React.ComponentPropsWithoutRef<"div"> & { disabled?: boolean }) => (
    <div
      role="menuitem"
      aria-disabled={disabled}
      tabIndex={disabled ? undefined : 0}
      onClick={disabled ? undefined : onClick}
      {...props}
    >
      {children}
    </div>
  ),
}));

describe("<AppointmentOutcomeRow />", () => {
  beforeEach(() => {
    vi.mocked(completeAppointmentAction).mockReset();
    vi.mocked(cancelAppointmentAction).mockReset();
  });

  it("renders Held / No-show / Reschedule / Cancel", () => {
    render(<AppointmentOutcomeRow taskId="task-1" assigneeId="user-1" />);

    expect(screen.getByTestId("appointment-held-task-1")).toBeInTheDocument();
    expect(
      screen.getByTestId("appointment-no-show-task-1"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("stub-reschedule-trigger-task-1"),
    ).toHaveTextContent("Reschedule");
    expect(screen.getByTestId("appointment-cancel-task-1")).toBeInTheDocument();
    expect(screen.getByTestId("appointment-held-task-1")).toHaveClass(
      "min-h-11",
    );
    expect(screen.getByTestId("appointment-no-show-task-1")).toHaveClass(
      "min-h-11",
    );
    expect(screen.getByTestId("appointment-cancel-task-1")).toHaveClass(
      "min-h-11",
    );
  });

  it("passes reschedule mode with the fixed assigneeId into the shared booking popover", () => {
    render(<AppointmentOutcomeRow taskId="task-1" assigneeId="user-2" />);

    expect(
      screen.getByTestId("stub-reschedule-trigger-task-1"),
    ).toBeInTheDocument();
  });

  it("clicking Held calls completeAppointmentAction with outcome 'held' and disables the row while pending", async () => {
    let resolve!: (
      v: Awaited<ReturnType<typeof completeAppointmentAction>>,
    ) => void;
    vi.mocked(completeAppointmentAction).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const user = userEvent.setup();
    render(<AppointmentOutcomeRow taskId="task-1" assigneeId="user-1" />);

    await user.click(screen.getByTestId("appointment-held-task-1"));

    expect(completeAppointmentAction).toHaveBeenCalledWith("task-1", "held");
    expect(screen.getByTestId("appointment-held-task-1")).toBeDisabled();
    expect(screen.getByTestId("appointment-no-show-task-1")).toBeDisabled();
    expect(screen.getByTestId("appointment-cancel-task-1")).toBeDisabled();

    await act(async () => {
      resolve({
        ok: true,
        data: { taskId: "task-1", status: "completed", outcome: "held" },
      });
    });
    await waitFor(() =>
      expect(screen.getByTestId("appointment-held-task-1")).toBeEnabled(),
    );
  });

  it("clicking No-show calls completeAppointmentAction with outcome 'no_show'", async () => {
    vi.mocked(completeAppointmentAction).mockResolvedValue({
      ok: true,
      data: { taskId: "task-1", status: "completed", outcome: "no_show" },
    });
    const user = userEvent.setup();
    render(<AppointmentOutcomeRow taskId="task-1" assigneeId="user-1" />);

    await user.click(screen.getByTestId("appointment-no-show-task-1"));

    await waitFor(() =>
      expect(completeAppointmentAction).toHaveBeenCalledWith(
        "task-1",
        "no_show",
      ),
    );
  });

  it("Cancel confirms inline before calling cancelAppointmentAction — first click shows Yes/Never mind, doesn't call yet", async () => {
    const user = userEvent.setup();
    render(<AppointmentOutcomeRow taskId="task-1" assigneeId="user-1" />);

    await user.click(screen.getByTestId("appointment-cancel-task-1"));

    expect(cancelAppointmentAction).not.toHaveBeenCalled();
    expect(
      screen.getByTestId("appointment-cancel-confirm-task-1"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("appointment-cancel-dismiss-task-1"),
    ).toBeInTheDocument();
    // The full button row (Held/No-show/Reschedule/first Cancel) steps
    // aside while confirming.
    expect(
      screen.queryByTestId("appointment-held-task-1"),
    ).not.toBeInTheDocument();
  });

  it("Never mind dismisses the confirm step without calling cancelAppointmentAction", async () => {
    const user = userEvent.setup();
    render(<AppointmentOutcomeRow taskId="task-1" assigneeId="user-1" />);

    await user.click(screen.getByTestId("appointment-cancel-task-1"));
    await user.click(screen.getByTestId("appointment-cancel-dismiss-task-1"));

    expect(cancelAppointmentAction).not.toHaveBeenCalled();
    expect(screen.getByTestId("appointment-cancel-task-1")).toBeInTheDocument();
  });

  it("second click (Yes, cancel) calls cancelAppointmentAction", async () => {
    vi.mocked(cancelAppointmentAction).mockResolvedValue({
      ok: true,
      data: { taskId: "task-1", status: "cancelled", ledgerId: "ledger-1" },
    });
    const user = userEvent.setup();
    render(<AppointmentOutcomeRow taskId="task-1" assigneeId="user-1" />);

    await user.click(screen.getByTestId("appointment-cancel-task-1"));
    await user.click(screen.getByTestId("appointment-cancel-confirm-task-1"));

    await waitFor(() =>
      expect(cancelAppointmentAction).toHaveBeenCalledWith("task-1"),
    );
    // Successful cancel resets back to the normal row (no longer confirming).
    await waitFor(() =>
      expect(
        screen.getByTestId("appointment-cancel-task-1"),
      ).toBeInTheDocument(),
    );
  });

  it("toasts the error message when completeAppointmentAction fails", async () => {
    const { toast } = await import("sonner");
    vi.mocked(completeAppointmentAction).mockResolvedValue({
      ok: false,
      error: { code: "CONFLICT", message: "Appointment already resolved" },
    });
    const user = userEvent.setup();
    render(<AppointmentOutcomeRow taskId="task-1" assigneeId="user-1" />);

    await user.click(screen.getByTestId("appointment-held-task-1"));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Appointment already resolved",
        expect.anything(),
      ),
    );
  });
});

describe("<AppointmentUpcomingActions />", () => {
  beforeEach(() => {
    vi.mocked(completeAppointmentAction).mockReset();
    vi.mocked(cancelAppointmentAction).mockReset();
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  it("renders the compact '...' menu with Reschedule and Cancel items", () => {
    render(<AppointmentUpcomingActions taskId="task-2" assigneeId="user-1" />);

    expect(screen.getByTestId("appointment-menu-task-2")).toBeInTheDocument();
    expect(screen.getByTestId("appointment-menu-task-2")).toHaveClass(
      "min-h-11",
      "min-w-11",
    );
    expect(
      screen.getByTestId("appointment-menu-reschedule-task-2"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("appointment-menu-cancel-task-2"),
    ).toBeInTheDocument();
    // The full outcome row never renders for a not-yet-due appointment.
    expect(
      screen.queryByTestId("appointment-held-task-2"),
    ).not.toBeInTheDocument();
  });

  it("clicking the Reschedule menu item opens the SAME booking popover (via the ref-click trigger)", async () => {
    const user = userEvent.setup();
    render(<AppointmentUpcomingActions taskId="task-2" assigneeId="user-1" />);

    expect(
      screen.queryByTestId("stub-reschedule-opened-task-2"),
    ).not.toBeInTheDocument();
    await user.click(screen.getByTestId("appointment-menu-reschedule-task-2"));

    expect(
      screen.getByTestId("stub-reschedule-opened-task-2"),
    ).toHaveTextContent("mode=reschedule assignee=user-1");
  });

  it("keeps the programmatic trigger out of tab order and restores focus to the visible actions button", async () => {
    const user = userEvent.setup();
    render(<AppointmentUpcomingActions taskId="task-2" assigneeId="user-1" />);

    const visibleTrigger = screen.getByTestId("appointment-menu-task-2");
    const hiddenTrigger = screen.getByTestId("stub-reschedule-trigger-task-2");
    expect(hiddenTrigger).toHaveAttribute("tabindex", "-1");

    await user.tab();
    expect(visibleTrigger).toHaveFocus();

    await user.click(screen.getByTestId("appointment-menu-reschedule-task-2"));
    await user.click(screen.getByTestId("stub-reschedule-close-task-2"));
    await waitFor(() => expect(visibleTrigger).toHaveFocus());
  });

  it("clicking the Cancel menu item confirms via window.confirm then calls cancelAppointmentAction", async () => {
    vi.mocked(cancelAppointmentAction).mockResolvedValue({
      ok: true,
      data: { taskId: "task-2", status: "cancelled", ledgerId: "ledger-2" },
    });
    const user = userEvent.setup();
    render(<AppointmentUpcomingActions taskId="task-2" assigneeId="user-1" />);

    await user.click(screen.getByTestId("appointment-menu-cancel-task-2"));

    expect(window.confirm).toHaveBeenCalled();
    await waitFor(() =>
      expect(cancelAppointmentAction).toHaveBeenCalledWith("task-2"),
    );
  });

  it("does not call cancelAppointmentAction when the confirm dialog is dismissed", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const user = userEvent.setup();
    render(<AppointmentUpcomingActions taskId="task-2" assigneeId="user-1" />);

    await user.click(screen.getByTestId("appointment-menu-cancel-task-2"));

    expect(cancelAppointmentAction).not.toHaveBeenCalled();
  });
});
