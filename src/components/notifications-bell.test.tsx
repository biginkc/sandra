import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NotificationsBell } from "./notifications-bell";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

const {
  getRecentNotifications,
  getUnreadCount,
  markAllRead,
  markRead,
  clearAllNotifications,
} = vi.hoisted(() => ({
  getRecentNotifications: vi.fn(),
  getUnreadCount: vi.fn(),
  markAllRead: vi.fn(),
  markRead: vi.fn(),
  clearAllNotifications: vi.fn(),
}));

vi.mock("@/app/(dashboard)/_actions/notifications", () => ({
  getRecentNotifications,
  getUnreadCount,
  markAllRead,
  markRead,
  clearAllNotifications,
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      getSession: () => Promise.resolve({ data: { session: null } }),
    },
    realtime: { setAuth: vi.fn() },
    channel: () => ({
      on() {
        return this;
      },
      subscribe: vi.fn(),
    }),
    removeChannel: vi.fn(),
  }),
}));

afterEach(() => {
  vi.clearAllMocks();
});

const HOUR_MS = 60 * 60 * 1000;

function isoMinusHours(h: number): string {
  return new Date(Date.now() - h * HOUR_MS).toISOString();
}

describe("<NotificationsBell />", () => {
  it("renders a relative timestamp under each notification once the dropdown opens", async () => {
    const user = userEvent.setup();
    getUnreadCount.mockResolvedValue({ ok: true, data: 2 });
    getRecentNotifications.mockResolvedValue({
      ok: true,
      data: [
        {
          id: "n-1",
          eventType: "owner_message_added",
          entityType: "property",
          entityId: "p-1",
          title: "Reply from owner",
          body: null,
          readAt: null,
          createdAt: isoMinusHours(2),
        },
        {
          id: "n-2",
          eventType: "bulk_action_completed",
          entityType: "job",
          entityId: "j-1",
          title: "Skip-trace finished",
          body: null,
          readAt: null,
          createdAt: isoMinusHours(36),
        },
      ],
    });

    render(<NotificationsBell userId="u-1" />);

    await user.click(screen.getByTestId("notifications-bell"));

    await waitFor(() => {
      expect(screen.getByTestId("notifications-item-time-n-1")).toBeVisible();
    });
    expect(screen.getByTestId("notifications-item-time-n-1").textContent).toMatch(
      /\b2 hours ago\b/i,
    );
    expect(screen.getByTestId("notifications-item-time-n-2").textContent).toMatch(
      /\b\d+ days? ago\b/i,
    );
  });

  it("shows a Clear all button when items are present and calls the action when clicked", async () => {
    const user = userEvent.setup();
    getUnreadCount.mockResolvedValue({ ok: true, data: 1 });
    getRecentNotifications.mockResolvedValue({
      ok: true,
      data: [
        {
          id: "n-1",
          eventType: "owner_message_added",
          entityType: "property",
          entityId: "p-1",
          title: "Hello",
          body: null,
          readAt: null,
          createdAt: isoMinusHours(1),
        },
      ],
    });
    clearAllNotifications.mockResolvedValue({ ok: true, data: null });

    render(<NotificationsBell userId="u-1" />);
    await user.click(screen.getByTestId("notifications-bell"));

    const clearBtn = await screen.findByTestId("notifications-clear-all");
    await user.click(clearBtn);

    expect(clearAllNotifications).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.getByText(/all caught up/i)).toBeVisible();
    });
    // Clear button hides once list is empty.
    expect(screen.queryByTestId("notifications-clear-all")).toBeNull();
  });

  it("does not show the Clear all button when there are no notifications", async () => {
    const user = userEvent.setup();
    getUnreadCount.mockResolvedValue({ ok: true, data: 0 });
    getRecentNotifications.mockResolvedValue({ ok: true, data: [] });

    render(<NotificationsBell userId="u-1" />);
    await user.click(screen.getByTestId("notifications-bell"));

    await screen.findByText(/all caught up/i);
    expect(screen.queryByTestId("notifications-clear-all")).toBeNull();
    expect(screen.queryByTestId("notifications-mark-all-read")).toBeNull();
  });

  it("shows Mark all + Clear side-by-side when there are unread items", async () => {
    const user = userEvent.setup();
    getUnreadCount.mockResolvedValue({ ok: true, data: 1 });
    getRecentNotifications.mockResolvedValue({
      ok: true,
      data: [
        {
          id: "n-1",
          eventType: "owner_message_added",
          entityType: "property",
          entityId: "p-1",
          title: "Hi",
          body: null,
          readAt: null,
          createdAt: isoMinusHours(0.5),
        },
      ],
    });

    render(<NotificationsBell userId="u-1" />);
    await user.click(screen.getByTestId("notifications-bell"));

    expect(
      await screen.findByTestId("notifications-mark-all-read"),
    ).toBeVisible();
    expect(screen.getByTestId("notifications-clear-all")).toBeVisible();
  });

  it("hides Mark all when every notification is already read but keeps Clear all", async () => {
    const user = userEvent.setup();
    getUnreadCount.mockResolvedValue({ ok: true, data: 0 });
    getRecentNotifications.mockResolvedValue({
      ok: true,
      data: [
        {
          id: "n-1",
          eventType: "owner_message_added",
          entityType: "property",
          entityId: "p-1",
          title: "Old",
          body: null,
          readAt: new Date().toISOString(),
          createdAt: isoMinusHours(48),
        },
      ],
    });

    render(<NotificationsBell userId="u-1" />);
    await user.click(screen.getByTestId("notifications-bell"));

    await screen.findByTestId("notifications-clear-all");
    expect(screen.queryByTestId("notifications-mark-all-read")).toBeNull();
  });
});
