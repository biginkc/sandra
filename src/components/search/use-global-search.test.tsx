import React, { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GlobalSearchProvider } from "./global-search-provider";
import { GlobalSearchTrigger } from "./global-search-trigger";
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
const row = (title: string) => ({ type: "property", key: title, title, subtitle: "City ST ZIP", matchedField: "address", href: `/leads/${title}` });
const response = (title = "Newest") => ({ ok: true, redirected: false, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ results: [row(title)] }) }) as Response;
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason?: unknown) => void; const promise = new Promise<T>((a,b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const tick = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const type = (value: string) => fireEvent.change(screen.getByRole("combobox"), { target: { value } });
const open = () => { const view = render(<StrictMode><GlobalSearchProvider><GlobalSearchTrigger /></GlobalSearchProvider></StrictMode>); fireEvent.click(screen.getByRole("button", { name: "Search" })); return view; };
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response())); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("search request lifecycle", () => {
  it("§12/3 minimum and exact 200 ms debounce render only qualifying results", async () => {
    open(); type("  ab  "); await tick(1000);
    expect(fetch).not.toHaveBeenCalled(); expect(screen.getByText("Type at least 3 characters")).toBeVisible();
    type("  abc  "); await tick(199);
    expect(fetch).not.toHaveBeenCalled(); expect(screen.queryByRole("option")).toBeNull(); expect(screen.getByRole("status")).toHaveTextContent("Searching");
    await tick(1); expect(fetch).toHaveBeenCalledTimes(1); expect(screen.getByRole("option")).toHaveTextContent("Newest");
    expect(fetch).toHaveBeenCalledWith("/api/search?q=abc", expect.anything());
    type("a"); expect(screen.queryByRole("option")).toBeNull(); expect(screen.getByText("Type at least 3 characters")).toBeVisible();
  });
  it("§12/4 rapid typing resets debounce and preserves literal encoded input (§12/5 UI only)", async () => {
    open(); for (const q of ["j", "je", "jer", "jerr", "jerry"]) { type(q); await tick(100); }
    expect(fetch).not.toHaveBeenCalled(); await tick(100); expect(screen.getByRole("option")).toHaveTextContent("Newest"); expect(fetch).toHaveBeenCalledTimes(1);
    type(" %_\\ "); await tick(200); expect(fetch).toHaveBeenLastCalledWith("/api/search?q=%25_%5C", expect.anything()); expect(screen.getByRole("option")).toHaveTextContent("Newest");
  });
  it.each(["fetch success", "fetch error", "json success", "json error"])("§12/4 rejects stale %s after a newer result", async kind => {
    const old = deferred<Response>(); const json = deferred<unknown>();
    vi.mocked(fetch).mockImplementationOnce(() => kind.startsWith("json") ? Promise.resolve({ ...response(), json: () => json.promise } as Response) : old.promise);
    open(); type("older"); await tick(200); const signal = vi.mocked(fetch).mock.calls[0][1]?.signal;
    type("newer"); expect(signal?.aborted).toBe(true); await tick(200);
    await act(async () => { if (kind === "fetch success") old.resolve(response("Old")); if (kind === "fetch error") old.reject(new Error()); if (kind === "json success") json.resolve({ results: [row("Old")] }); if (kind === "json error") json.reject(new Error()); });
    expect(screen.getByRole("option")).toHaveTextContent("Newest"); expect(screen.queryByText("Old")).toBeNull(); expect(screen.queryByRole("alert")).toBeNull();
  });
  it.each(["clear", "close", "unmount"])("§12/4 cancels pending timers and late JSON on %s", async action => {
    const json = deferred<unknown>(); vi.mocked(fetch).mockResolvedValueOnce({ ...response(), json: () => json.promise } as Response);
    const view = open(); type("older"); await tick(200);
    const signal = vi.mocked(fetch).mock.calls[0][1]?.signal;
    if (action === "clear") fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    else if (action === "close") fireEvent.click(screen.getByRole("button", { name: "Close search" }));
    else view.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => json.resolve({ results: [row("Old")] })); await tick(16000);
    if (action === "close") fireEvent.click(screen.getByRole("button", { name: "Search" }));
    if (action !== "unmount") expect(screen.getByText("Type at least 3 characters")).toBeVisible();
    expect(screen.queryByRole("option")).toBeNull(); expect(screen.queryByRole("alert")).toBeNull(); expect(screen.queryByTestId("search-skeleton")).toBeNull();
  });
  it.each(["clear", "close", "unmount"])("§12/4 cancels undispatched debounce on %s", async action => {
    const view = open(); type("older"); await tick(199);
    if (action === "clear") fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    else if (action === "close") fireEvent.click(screen.getByRole("button", { name: "Close search" })); else view.unmount();
    await tick(16000); expect(fetch).not.toHaveBeenCalled(); expect(screen.queryByRole("option")).toBeNull();
  });
  it.each(["401", "500", "network", "malformed JSON", "non-array", "null", "redirect", "html", "degraded"])("§12/13 %s clears retained rows and recovers on next keystroke", async kind => {
    open(); type("first"); await tick(200); expect(screen.getByRole("option")).toBeVisible();
    let reply = response();
    if (["401", "500"].includes(kind)) reply = { ...reply, ok: false, status: Number(kind) } as Response;
    if (kind === "redirect") reply = { ...reply, redirected: true } as Response;
    if (kind === "html") reply = { ...reply, headers: new Headers({ "content-type": "text/html" }) } as Response;
    if (kind === "malformed JSON") reply = { ...reply, json: async () => { throw new SyntaxError(); } } as Response;
    if (kind === "non-array") reply = { ...reply, json: async () => ({ results: {} }) } as Response;
    if (kind === "null") reply = { ...reply, json: async () => null } as Response;
    if (kind === "degraded") reply = { ...reply, json: async () => ({ results: [], degraded: true }) } as Response;
    if (kind === "network") vi.mocked(fetch).mockRejectedValueOnce(new Error()); else vi.mocked(fetch).mockResolvedValueOnce(reply);
    type("failed"); await tick(200); expect(screen.getByRole("alert")).toHaveTextContent("Search unavailable"); expect(screen.queryByRole("option")).toBeNull(); expect(screen.queryByTestId("search-spinner")).toBeNull(); expect(screen.queryByTestId("search-progress")).toBeNull();
    type("retry"); await tick(200); expect(screen.getByRole("option")).toHaveTextContent("Newest"); expect(screen.queryByRole("alert")).toBeNull();
  });
  it("§12/14 deadline is 15 seconds from dispatch, aborts, rejects 16 second response and recovers", async () => {
    const old = deferred<Response>(); vi.mocked(fetch).mockReturnValueOnce(old.promise);
    open(); type("stalled"); await tick(200); const signal = vi.mocked(fetch).mock.calls[0][1]?.signal;
    await tick(14999); expect(screen.queryByRole("alert")).toBeNull(); expect(screen.getByRole("status")).toHaveTextContent("Searching");
    await tick(1); expect(screen.getByRole("alert")).toHaveTextContent("Search unavailable"); expect(signal?.aborted).toBe(true); expect(screen.queryByTestId("search-skeleton")).toBeNull();
    await tick(1000); await act(async () => old.resolve(response("Too late"))); expect(screen.queryByRole("option")).toBeNull();
    type("retry"); await tick(200); expect(screen.getByRole("option")).toHaveTextContent("Newest");
  });
  it("§12/15 a 300 ms response never shows skeleton", async () => {
    const old = deferred<Response>(); vi.mocked(fetch).mockReturnValueOnce(old.promise); open(); type("query");
    expect(screen.getByTestId("search-spinner")).toBeVisible(); expect(screen.getByTestId("search-progress")).toBeVisible();
    await tick(200); await tick(300); expect(screen.queryByTestId("search-skeleton")).toBeNull();
    await act(async () => old.resolve(response())); await tick(200); expect(screen.queryByTestId("search-skeleton")).toBeNull(); expect(screen.getByRole("option")).toBeVisible();
  });
  it("§12/15 a 1 second response shows skeleton exactly 400 ms after dispatch", async () => {
    const old = deferred<Response>(); vi.mocked(fetch).mockReturnValueOnce(old.promise); open(); type("query"); await tick(200); await tick(399); expect(screen.queryByTestId("search-skeleton")).toBeNull();
    await tick(1); expect(screen.getByTestId("search-skeleton")).toBeVisible(); await tick(600); await act(async () => old.resolve(response())); expect(screen.queryByTestId("search-skeleton")).toBeNull(); expect(screen.getByRole("option")).toBeVisible();
  });
  it("§12/15 input resets skeleton delay; retained results stay dimmed and actionable", async () => {
    vi.mocked(fetch).mockReturnValueOnce(new Promise(() => {})); open(); type("older"); await tick(600); expect(screen.getByTestId("search-skeleton")).toBeVisible();
    type("newer"); expect(screen.queryByTestId("search-skeleton")).toBeNull(); await tick(200); expect(screen.getByRole("option")).toBeVisible();
    vi.mocked(fetch).mockReturnValueOnce(new Promise(() => {})); type("again"); await tick(1000);
    expect(screen.getByRole("listbox")).toHaveAttribute("data-retained", "true"); expect(screen.getByRole("option")).toBeVisible(); expect(screen.queryByTestId("search-skeleton")).toBeNull(); expect(screen.getByRole("status")).toHaveTextContent("Previous results");
    fireEvent.click(screen.getByRole("option")); expect(screen.queryByRole("dialog")).toBeNull();
  });
});
