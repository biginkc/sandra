import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CallbackDueItem } from "@/lib/my-leads/call-state";
import { CallbackDueBanner } from "./callback-due-banner";

const item = (id: string, over: Partial<CallbackDueItem> = {}): CallbackDueItem => ({
  taskId: `t-${id}`, propertyId: id, dueAt: "2026-10-04T19:30:00Z", title: `Callback ${id}`, minutesLate: 0, ...over,
});

const original = globalThis.Notification;
const created: { title: string; body?: string }[] = [];
const requestPermission = vi.fn();

function stubNotification(permission: string) {
  class Fake {
    static permission = permission;
    static requestPermission = requestPermission;
    constructor(title: string, opts?: { body?: string }) {
      created.push({ title, body: opts?.body });
    }
  }
  Object.defineProperty(globalThis, "Notification", { configurable: true, writable: true, value: Fake });
}

const base = { labelFor: (id: string) => `Lead ${id}`, onCall: vi.fn(), callingPropertyId: null, canCall: true };

beforeEach(() => {
  created.length = 0;
  requestPermission.mockReset();
  base.onCall = vi.fn();
  localStorage.clear();
  stubNotification("default");
});
afterEach(() => {
  Object.defineProperty(globalThis, "Notification", { configurable: true, writable: true, value: original });
  vi.restoreAllMocks();
});

describe("<CallbackDueBanner />", () => {
  it("renders nothing when empty", () => {
    render(<CallbackDueBanner {...base} items={[]} />);
    expect(screen.queryByTestId("callback-due-banner")).not.toBeInTheDocument();
  });

  it("lists items with label, Chicago time and lateness", () => {
    render(<CallbackDueBanner {...base} items={[item("a"), item("b", { minutesLate: 12 })]} />);
    expect(screen.getByTestId("callback-due-banner")).toHaveAttribute("role", "alert");
    expect(screen.getByTestId("callback-due-a")).toHaveTextContent("Lead a");
    expect(screen.getByTestId("callback-due-a")).toHaveTextContent("2:30 PM");
    expect(screen.getByTestId("callback-due-a")).toHaveTextContent("Callback due now");
    expect(screen.getByTestId("callback-due-b")).toHaveTextContent("12 min late");
  });

  it("falls back to the task title without a label", () => {
    render(<CallbackDueBanner {...base} labelFor={() => null} items={[item("a")]} />);
    expect(screen.getByTestId("callback-due-a")).toHaveTextContent("Callback a");
  });

  it("calls once on click and disables while calling or when not allowed", async () => {
    const { rerender } = render(<CallbackDueBanner {...base} items={[item("a")]} />);
    await userEvent.click(screen.getByTestId("callback-call-a"));
    expect(base.onCall).toHaveBeenCalledTimes(1);
    expect(base.onCall).toHaveBeenCalledWith("a");
    rerender(<CallbackDueBanner {...base} items={[item("a")]} callingPropertyId="a" />);
    expect(screen.getByTestId("callback-call-a")).toBeDisabled();
    rerender(<CallbackDueBanner {...base} items={[item("a")]} canCall={false} />);
    expect(screen.getByTestId("callback-call-a")).toBeDisabled();
  });

  it("never dials without a click", () => {
    render(<CallbackDueBanner {...base} items={[item("a")]} />);
    expect(base.onCall).not.toHaveBeenCalled();
  });

  it.each(["default", "denied"])("constructs no Notification when permission is %s", (perm) => {
    stubNotification(perm);
    render(<CallbackDueBanner {...base} items={[item("a")]} />);
    expect(created).toEqual([]);
  });

  it("notifies exactly once per task across re-renders when granted", () => {
    stubNotification("granted");
    const items = [item("once")];
    const { rerender } = render(<CallbackDueBanner {...base} items={items} />);
    rerender(<CallbackDueBanner {...base} items={[item("once")]} />);
    rerender(<CallbackDueBanner {...base} items={[item("once"), item("twice")]} />);
    expect(created).toEqual([
      { title: "Callback due now", body: "Lead once" },
      { title: "Callback due now", body: "Lead twice" },
    ]);
    expect(JSON.parse(localStorage.getItem("my-leads:callback-alerted") ?? "[]")).toHaveLength(2);
  });

  it("requests permission only on click", async () => {
    requestPermission.mockResolvedValue("denied");
    render(<CallbackDueBanner {...base} items={[item("a")]} />);
    expect(requestPermission).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Enable alerts" }));
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it("survives localStorage failures", () => {
    stubNotification("granted");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    render(<CallbackDueBanner {...base} items={[item("ls")]} />);
    expect(screen.getByTestId("callback-call-ls")).toBeInTheDocument();
    expect(created).toHaveLength(1);
  });
});
