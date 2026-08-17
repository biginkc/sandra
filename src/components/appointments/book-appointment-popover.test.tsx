import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BookAppointmentPopover } from "./book-appointment-popover";
import {
  bookAppointment,
  checkAppointmentOverlap,
  getMemberTimezone,
} from "./book-appointment-action";
import { rescheduleAppointmentAction } from "./lifecycle-actions";

// Mirrors the assign-dropdown.test.tsx convention: mock the base-ui-backed
// ui/* primitives (no ResizeObserver/PointerEvent polyfills in this jsdom
// setup) so the test exercises BookAppointmentPopover's own state and
// server-action calls, not react-day-picker/base-ui internals.
vi.mock("@/components/ui/popover", () => {
  const Ctx = React.createContext<{
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }>({ open: false, onOpenChange: () => {} });
  return {
    Popover: ({
      open,
      onOpenChange,
      children,
    }: {
      open: boolean;
      onOpenChange: (open: boolean) => void;
      children: React.ReactNode;
    }) => (
      <Ctx.Provider value={{ open, onOpenChange }}>{children}</Ctx.Provider>
    ),
    PopoverTrigger: ({
      render,
    }: {
      render: React.ReactElement<{ onClick?: () => void }>;
    }) => {
      const { onOpenChange } = React.useContext(Ctx);
      return React.cloneElement(render, { onClick: () => onOpenChange(true) });
    },
    PopoverContent: ({ children }: { children: React.ReactNode }) => {
      const { open } = React.useContext(Ctx);
      return open ? <div>{children}</div> : null;
    },
  };
});

vi.mock("@/components/ui/calendar", () => ({
  Calendar: ({
    selected,
    onSelect,
  }: {
    selected?: Date;
    onSelect: (date: Date | undefined) => void;
  }) => (
    <input
      type="date"
      data-testid="book-appointment-calendar"
      value={
        selected
          ? `${selected.getFullYear()}-${String(selected.getMonth() + 1).padStart(2, "0")}-${String(selected.getDate()).padStart(2, "0")}`
          : ""
      }
      onChange={(e) => {
        const [y, m, d] = e.target.value.split("-").map(Number);
        onSelect(y && m && d ? new Date(y, m - 1, d) : undefined);
      }}
    />
  ),
}));

vi.mock("@/components/ui/select", () => {
  const Ctx = React.createContext<{
    onValueChange: (value: string | null) => void;
  }>({ onValueChange: () => {} });
  return {
    Select: ({
      onValueChange,
      children,
    }: {
      onValueChange: (value: string | null) => void;
      children: React.ReactNode;
    }) => <Ctx.Provider value={{ onValueChange }}>{children}</Ctx.Provider>,
    SelectTrigger: ({
      children,
      ...props
    }: React.ComponentPropsWithoutRef<"div">) => (
      <div {...props}>{children}</div>
    ),
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
    SelectItem: ({
      value,
      children,
    }: {
      value: string;
      children: React.ReactNode;
    }) => {
      const { onValueChange } = React.useContext(Ctx);
      return (
        <button
          type="button"
          data-testid={`select-item-${value}`}
          onClick={() => onValueChange(value)}
        >
          {children}
        </button>
      );
    },
  };
});

vi.mock("@/app/(dashboard)/messages/_components/assignee-select", () => ({
  AssigneeSelect: ({
    value,
    onChange,
  }: {
    value: string | null;
    onChange: (id: string | null) => void;
  }) => (
    <select
      data-testid="assignee-select"
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
    >
      <option value="user-1">Me</option>
      <option value="user-2">Teammate</option>
    </select>
  ),
}));

vi.mock("./book-appointment-action", () => ({
  bookAppointment: vi.fn(),
  checkAppointmentOverlap: vi.fn(),
  getMemberTimezone: vi.fn(),
}));

vi.mock("./lifecycle-actions", () => ({
  rescheduleAppointmentAction: vi.fn(),
}));

async function openAndFillHappyPath() {
  const user = userEvent.setup();
  await user.click(screen.getByTestId("book-appointment-trigger"));

  fireEvent.change(screen.getByTestId("book-appointment-calendar"), {
    target: { value: "2026-06-15" },
  });
  await user.click(screen.getByTestId("select-item-14:00"));

  return user;
}

describe("<BookAppointmentPopover />", () => {
  beforeEach(() => {
    vi.mocked(bookAppointment).mockReset();
    vi.mocked(checkAppointmentOverlap).mockReset();
    vi.mocked(checkAppointmentOverlap).mockResolvedValue({
      ok: true,
      data: { hasOverlap: false, conflictStartAt: null },
    });
    vi.mocked(getMemberTimezone).mockReset();
    vi.mocked(getMemberTimezone).mockResolvedValue({
      ok: true,
      data: "America/Chicago",
    });
  });

  it("opens from the trigger and shows the form fields", async () => {
    const user = userEvent.setup();
    render(
      <BookAppointmentPopover propertyId="prop-1" currentUserId="user-1" />,
    );

    expect(
      screen.queryByTestId("book-appointment-calendar"),
    ).not.toBeInTheDocument();
    await user.click(screen.getByTestId("book-appointment-trigger"));

    expect(screen.getByTestId("book-appointment-calendar")).toBeInTheDocument();
    expect(screen.getByTestId("book-appointment-duration")).toBeInTheDocument();
    expect(screen.getByTestId("assignee-select")).toBeInTheDocument();
    expect(screen.getByTestId("book-appointment-note")).toBeInTheDocument();
    expect(screen.getByTestId("book-appointment-submit")).toBeDisabled();
  });

  it("shows the assignee's timezone once resolved", async () => {
    render(
      <BookAppointmentPopover propertyId="prop-1" currentUserId="user-1" />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByTestId("book-appointment-trigger"));

    expect(getMemberTimezone).toHaveBeenCalledWith("user-1");
    expect(
      await screen.findByTestId("book-appointment-timezone-label"),
    ).toHaveTextContent("America/Chicago");
  });

  it("computes the end-time preview from date + time + duration and updates it when duration changes", async () => {
    render(
      <BookAppointmentPopover propertyId="prop-1" currentUserId="user-1" />,
    );
    await openAndFillHappyPath();

    expect(
      await screen.findByTestId("book-appointment-end-label"),
    ).toHaveTextContent("2:30 PM");

    const user = userEvent.setup();
    await user.click(screen.getByTestId("select-item-60"));

    expect(
      await screen.findByTestId("book-appointment-end-label"),
    ).toHaveTextContent("3:00 PM");
  });

  it("shows an inline error for a wall time that doesn't exist across a DST gap and blocks submit", async () => {
    render(
      <BookAppointmentPopover propertyId="prop-1" currentUserId="user-1" />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByTestId("book-appointment-trigger"));

    await waitFor(() => expect(getMemberTimezone).toHaveBeenCalled());

    // America/Chicago springs forward at 2026-03-08 02:00 -> 03:00; 02:30
    // never occurs that day (same fixture zoned.ts's own doc comment uses).
    fireEvent.change(screen.getByTestId("book-appointment-calendar"), {
      target: { value: "2026-03-08" },
    });
    await user.click(screen.getByTestId("select-item-02:30"));

    expect(
      await screen.findByTestId("book-appointment-dst-error"),
    ).toHaveTextContent("daylight-saving change");
    expect(screen.getByTestId("book-appointment-submit")).toBeDisabled();
    expect(bookAppointment).not.toHaveBeenCalled();
  });

  it("submits the raw wall-clock fields (never a pre-converted Date) and closes on success", async () => {
    vi.mocked(bookAppointment).mockResolvedValue({
      ok: true,
      data: {
        taskId: "task-1",
        alreadyQualified: false,
        chainId: "chain-1",
        duplicate: false,
      },
    });
    const onBooked = vi.fn();
    render(
      <BookAppointmentPopover
        propertyId="prop-1"
        contactId="contact-1"
        subjectLabel="123 Main St"
        currentUserId="user-1"
        onBooked={onBooked}
      />,
    );
    const user = await openAndFillHappyPath();
    await screen.findByTestId("book-appointment-end-label");

    await user.type(screen.getByTestId("book-appointment-note"), "Bring comps");
    await user.click(screen.getByTestId("book-appointment-submit"));

    await waitFor(() => expect(bookAppointment).toHaveBeenCalledTimes(1));
    expect(bookAppointment).toHaveBeenCalledWith({
      propertyId: "prop-1",
      contactId: "contact-1",
      assigneeId: "user-1",
      date: "2026-06-15",
      time: "14:00",
      timeZone: "America/Chicago",
      durationMinutes: 30,
      title: "Appointment — 123 Main St",
      note: "Bring comps",
      idempotencyKey: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      ),
    });
    await waitFor(() =>
      expect(onBooked).toHaveBeenCalledWith({
        taskId: "task-1",
        alreadyQualified: false,
        chainId: "chain-1",
        duplicate: false,
      }),
    );
    await waitFor(() =>
      expect(
        screen.queryByTestId("book-appointment-calendar"),
      ).not.toBeInTheDocument(),
    );
  });

  it("mints a fresh idempotency key on each open, so a second booking after a successful one never reuses the first key", async () => {
    vi.mocked(bookAppointment).mockResolvedValue({
      ok: true,
      data: {
        taskId: "task-1",
        alreadyQualified: false,
        chainId: "chain-1",
        duplicate: false,
      },
    });
    render(
      <BookAppointmentPopover propertyId="prop-1" currentUserId="user-1" />,
    );

    let user = await openAndFillHappyPath();
    await user.click(screen.getByTestId("book-appointment-submit"));
    await waitFor(() => expect(bookAppointment).toHaveBeenCalledTimes(1));
    const firstKey =
      vi.mocked(bookAppointment).mock.calls[0]![0].idempotencyKey;
    expect(firstKey).toEqual(expect.any(String));

    // Popover closed on success (asserted above); reopening for a second,
    // genuinely new booking must mint a new key rather than resubmitting
    // the first one.
    user = await openAndFillHappyPath();
    await user.click(screen.getByTestId("book-appointment-submit"));
    await waitFor(() => expect(bookAppointment).toHaveBeenCalledTimes(2));
    const secondKey =
      vi.mocked(bookAppointment).mock.calls[1]![0].idempotencyKey;

    expect(secondKey).toEqual(expect.any(String));
    expect(secondKey).not.toBe(firstKey);
  });

  it("shows a non-blocking double-book warning without disabling submit", async () => {
    vi.mocked(checkAppointmentOverlap).mockResolvedValue({
      ok: true,
      data: { hasOverlap: true, conflictStartAt: "2026-06-15T19:00:00.000Z" },
    });
    render(
      <BookAppointmentPopover propertyId="prop-1" currentUserId="user-1" />,
    );
    await openAndFillHappyPath();
    await screen.findByTestId("book-appointment-end-label");

    expect(
      await screen.findByTestId("book-appointment-overlap-warning"),
    ).toHaveTextContent("book anyway?");
    expect(screen.getByTestId("book-appointment-submit")).toBeEnabled();
  });

  describe('mode="reschedule"', () => {
    beforeEach(() => {
      vi.mocked(rescheduleAppointmentAction).mockReset();
    });

    it("hides the assignee select and note, and fixes the timezone lookup to the given assigneeId", async () => {
      render(
        <BookAppointmentPopover
          mode="reschedule"
          taskId="task-1"
          assigneeId="user-2"
          currentUserId="user-2"
        />,
      );
      const user = userEvent.setup();
      await user.click(screen.getByTestId("book-appointment-trigger"));

      expect(getMemberTimezone).toHaveBeenCalledWith("user-2");
      expect(screen.queryByTestId("assignee-select")).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("book-appointment-note"),
      ).not.toBeInTheDocument();
      expect(screen.getByTestId("book-appointment-submit")).toHaveTextContent(
        "Reschedule",
      );
    });

    it("submits via rescheduleAppointmentAction with the taskId and picked date/time (no assignee/title/note fields) and calls onRescheduled", async () => {
      vi.mocked(rescheduleAppointmentAction).mockResolvedValue({
        ok: true,
        data: {
          taskId: "task-2",
          oldTaskId: "task-1",
          chainId: "chain-1",
          ledgerId: "ledger-1",
          duplicate: false,
        },
      });
      const onRescheduled = vi.fn();
      render(
        <BookAppointmentPopover
          mode="reschedule"
          taskId="task-1"
          assigneeId="user-2"
          currentUserId="user-2"
          onRescheduled={onRescheduled}
        />,
      );
      await openAndFillHappyPath();
      await screen.findByTestId("book-appointment-end-label");
      await userEvent
        .setup()
        .click(screen.getByTestId("book-appointment-submit"));

      await waitFor(() =>
        expect(rescheduleAppointmentAction).toHaveBeenCalledTimes(1),
      );
      expect(rescheduleAppointmentAction).toHaveBeenCalledWith({
        taskId: "task-1",
        date: "2026-06-15",
        time: "14:00",
        timeZone: "America/Chicago",
        durationMinutes: 30,
        idempotencyKey: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        ),
      });
      expect(bookAppointment).not.toHaveBeenCalled();
      await waitFor(() =>
        expect(onRescheduled).toHaveBeenCalledWith({
          taskId: "task-2",
          oldTaskId: "task-1",
          chainId: "chain-1",
          ledgerId: "ledger-1",
          duplicate: false,
        }),
      );
    });

    it("opens via an externally-clicked triggerRef, not just a direct user click", async () => {
      const ref = { current: null as HTMLButtonElement | null };
      render(
        <BookAppointmentPopover
          mode="reschedule"
          taskId="task-1"
          assigneeId="user-2"
          currentUserId="user-2"
          triggerRef={ref}
        />,
      );

      expect(
        screen.queryByTestId("book-appointment-calendar"),
      ).not.toBeInTheDocument();
      act(() => {
        ref.current?.click();
      });

      expect(
        await screen.findByTestId("book-appointment-calendar"),
      ).toBeInTheDocument();
    });
  });
});
