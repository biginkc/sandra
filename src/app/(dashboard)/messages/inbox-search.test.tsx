import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InboxSearch } from "./inbox-search";
const state = vi.hoisted(() => ({ query: "filter=unread&inboxPage=3&hideDnc=0", replace: vi.fn(), pending: false }));
// Keep navigation pending until the test delivers URL commits and settles it.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useTransition: () => [state.pending, (callback: () => void) => {
    state.pending = true;
    callback();
  }] };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: state.replace }), useSearchParams: () => new URLSearchParams(state.query) }));
beforeEach(() => { vi.useFakeTimers(); state.replace.mockReset(); state.pending = false; state.query = "filter=unread&inboxPage=3&hideDnc=0"; });
afterEach(() => vi.useRealTimers());
describe("inbox search URL", () => {
  it("debounces input, writes search, resets page, and preserves filters", () => {
    render(<InboxSearch />);
    const input = screen.getByRole("textbox", { name: "Search messages" });
    fireEvent.change(input, { target: { value: "Zeph" } });
    act(() => vi.advanceTimersByTime(100));
    fireEvent.change(input, { target: { value: "Zephyrson" } });
    act(() => vi.advanceTimersByTime(199)); expect(state.replace).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(state.replace).toHaveBeenCalledTimes(1);
    const url = new URL(state.replace.mock.calls[0][0], "http://localhost");
    expect(url.searchParams.get("search")).toBe("Zephyrson");
    expect(url.searchParams.has("inboxPage")).toBe(false);
    expect(url.searchParams.get("filter")).toBe("unread");
    expect(url.searchParams.get("hideDnc")).toBe("0");
    expect(state.replace.mock.calls[0][1]).toEqual({ scroll: false });
  });
  it("preserves newer typing when an earlier local navigation completes", () => {
    const view = render(<InboxSearch />);
    const input = screen.getByRole("textbox", { name: "Search messages" });
    fireEvent.change(input, { target: { value: "Zeph" } });
    act(() => vi.advanceTimersByTime(200));
    expect(state.replace).toHaveBeenCalledTimes(1);
    fireEvent.change(input, { target: { value: "Zephyrson" } });
    state.query = new URL(state.replace.mock.calls[0][0], "http://localhost").search.slice(1);
    view.rerender(<InboxSearch />);
    expect(input).toHaveValue("Zephyrson");
    state.pending = false;
    view.rerender(<InboxSearch />);
    expect(input).toHaveValue("Zephyrson");
    act(() => vi.advanceTimersByTime(200));
    expect(state.replace).toHaveBeenCalledTimes(2);
    expect(new URL(state.replace.mock.calls[1][0], "http://localhost").searchParams.get("search")).toBe("Zephyrson");
  });
  it("preserves the newest draft with two local navigations in flight", () => {
    const view = render(<InboxSearch />);
    const input = screen.getByRole("textbox", { name: "Search messages" });
    fireEvent.change(input, { target: { value: "Zeph" } });
    act(() => vi.advanceTimersByTime(200));
    fireEvent.change(input, { target: { value: "Zephyrson" } });
    act(() => vi.advanceTimersByTime(200));
    expect(state.replace).toHaveBeenCalledTimes(2);
    fireEvent.change(input, { target: { value: "Zephyrson Jr" } });
    state.query = new URL(state.replace.mock.calls[0][0], "http://localhost").search.slice(1);
    view.rerender(<InboxSearch />);
    expect(input).toHaveValue("Zephyrson Jr");
    act(() => vi.advanceTimersByTime(200));
    expect(state.replace).toHaveBeenCalledTimes(3);
    expect(new URL(state.replace.mock.calls[2][0], "http://localhost").searchParams.get("search")).toBe("Zephyrson Jr");
    // No debounce remains, but an older URL still cannot win while in flight.
    state.query = new URL(state.replace.mock.calls[1][0], "http://localhost").search.slice(1);
    view.rerender(<InboxSearch />);
    expect(input).toHaveValue("Zephyrson Jr");
    state.query = new URL(state.replace.mock.calls[2][0], "http://localhost").search.slice(1);
    state.pending = false;
    view.rerender(<InboxSearch />);
    state.query = "search=Backvalue";
    view.rerender(<InboxSearch />);
    expect(input).toHaveValue("Backvalue");
  });
  it("syncs an external filter change while idle after local completion", () => {
    const view = render(<InboxSearch />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Zeph" } });
    act(() => vi.advanceTimersByTime(200));
    state.query = "filter=unread&search=Zeph";
    view.rerender(<InboxSearch />);
    state.pending = false;
    view.rerender(<InboxSearch />);
    state.query = "filter=all";
    view.rerender(<InboxSearch />);
    expect(input).toHaveValue("");
    act(() => vi.advanceTimersByTime(200));
    expect(state.replace).toHaveBeenCalledTimes(1);
  });
  it("clears search, syncs idle external navigation, and cancels edits on unmount", () => {
    state.query += "&search=Zephyrson";
    const view = render(<InboxSearch degraded />);
    const input = screen.getByRole("textbox");
    expect(input).toHaveValue("Zephyrson"); expect(screen.getByText("Search unavailable")).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "" } });
    act(() => vi.advanceTimersByTime(200));
    expect(state.replace.mock.calls[0][0]).not.toContain("search=");
    view.rerender(<InboxSearch />);
    state.pending = false;
    state.query = "search=Backvalue"; view.rerender(<InboxSearch />);
    expect(input).toHaveValue("Backvalue");
    act(() => vi.advanceTimersByTime(200)); expect(state.replace).toHaveBeenCalledTimes(1);
    fireEvent.change(input, { target: { value: "unmounted" } }); view.unmount();
    act(() => vi.advanceTimersByTime(200)); expect(state.replace).toHaveBeenCalledTimes(1);
  });
});
