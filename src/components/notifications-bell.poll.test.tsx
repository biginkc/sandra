import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { NotificationsBell } from "./notifications-bell";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const { getUnreadCount, rt } = vi.hoisted(() => ({
  getUnreadCount: vi.fn(),
  rt: {
    order: [] as string[],
    handlers: {} as Record<string, (payload: unknown) => void>,
    status: null as null | ((status: string) => void),
    releaseAuth: () => {},
  },
}));

vi.mock("@/app/(dashboard)/_actions/notifications", () => ({
  getUnreadCount,
  getRecentNotifications: vi.fn(),
  markAllRead: vi.fn(),
  markRead: vi.fn(),
  clearAllNotifications: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { getSession: async () => ({ data: { session: { access_token: "jwt" } } }) },
    realtime: {
      setAuth: () => new Promise<void>((resolve) => {
        rt.order.push("setAuth:start");
        rt.releaseAuth = () => { rt.order.push("setAuth:done"); resolve(); };
      }),
    },
    channel: () => {
      const channel = {
        on(_type: string, filter: { event: string }, handler: (payload: unknown) => void) {
          rt.handlers[filter.event] = handler;
          return channel;
        },
        subscribe(cb: (status: string) => void) {
          rt.order.push("subscribe");
          rt.status = cb;
          return channel;
        },
      };
      return channel;
    },
    removeChannel: vi.fn(),
  }),
}));

let hidden = false;
beforeEach(() => {
  vi.useFakeTimers();
  hidden = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  rt.order = [];
  rt.handlers = {};
  rt.status = null;
  getUnreadCount.mockResolvedValue({ ok: true, data: 3 });
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

const flush = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)));
const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

async function mount() {
  render(<NotificationsBell userId="u-1" />);
  await flush();
  await act(async () => rt.releaseAuth());
  await flush();
  rt.status?.("SUBSCRIBED");
  await flush();
}

it("awaits setAuth before subscribing", async () => {
  render(<NotificationsBell userId="u-1" />);
  await flush();
  expect(rt.order).toEqual(["setAuth:start"]);
  await act(async () => rt.releaseAuth());
  await flush();
  expect(rt.order).toEqual(["setAuth:start", "setAuth:done", "subscribe"]);
});

it("reconciles every 60 s while visible and not at all while hidden", async () => {
  await mount();
  expect(getUnreadCount).toHaveBeenCalledTimes(1);
  await advance(59_000);
  expect(getUnreadCount).toHaveBeenCalledTimes(1);
  await advance(1_000);
  expect(getUnreadCount).toHaveBeenCalledTimes(2);
  hidden = true;
  await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
  await advance(300_000);
  expect(getUnreadCount).toHaveBeenCalledTimes(2);
});

it("refreshes immediately when the tab becomes visible", async () => {
  hidden = true;
  await mount();
  await advance(120_000);
  expect(getUnreadCount).toHaveBeenCalledTimes(1);
  hidden = false;
  await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
  await flush();
  expect(getUnreadCount).toHaveBeenCalledTimes(2);
  await advance(60_000);
  expect(getUnreadCount).toHaveBeenCalledTimes(3);
});

it("refreshes on realtime reconnect, not on the first join", async () => {
  await mount();
  expect(getUnreadCount).toHaveBeenCalledTimes(1);
  rt.status?.("CHANNEL_ERROR");
  getUnreadCount.mockResolvedValue({ ok: true, data: 5 });
  await act(async () => rt.status?.("SUBSCRIBED"));
  await flush();
  expect(getUnreadCount).toHaveBeenCalledTimes(2);
  expect(screen.getByTestId("notifications-bell")).toHaveTextContent("5");
});

it("a DELETE re-reads the count so a deleted unread notification lowers it", async () => {
  await mount();
  expect(screen.getByTestId("notifications-bell")).toHaveTextContent("3");
  getUnreadCount.mockResolvedValue({ ok: true, data: 2 });
  await act(async () => rt.handlers.DELETE({ old: { id: "n-1" } }));
  await flush();
  expect(screen.getByTestId("notifications-bell")).toHaveTextContent("2");
});
