import React from "react";
import { act, fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
import { GlobalSearch } from "./global-search";
const row = (title: string, type = "property") => ({ type, key: `${type}-${title}`, title, subtitle: "Subtitle", matchedField: "phone", href: `/leads/${title}` });
const response = (results = [row("New")]) => ({ ok: true, redirected: false, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ results }) });
const deferred = () => { let resolve!: (value: ReturnType<typeof response>) => void; const promise = new Promise<ReturnType<typeof response>>(r => { resolve = r; }); return { promise, resolve }; };
const open = () => { render(<GlobalSearch />); fireEvent.keyDown(window, { key: "k", metaKey: true }); };
const type = (q: string) => fireEvent.change(screen.getByRole("combobox"), { target: { value: q } });
beforeEach(() => {
  push.mockReset();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response()));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("global search", () => {
  it("opens with Cmd-K, renders ordered groups and navigates with Enter", async () => {
    vi.mocked(fetch).mockResolvedValue(response([row("Home"), row("Ada", "owner"), row("SMS", "thread")]) as unknown as Response);
    open(); type("query");
    await screen.findByText("Home");
    expect(screen.getByText("Properties")).toBeInTheDocument(); expect(screen.getByText("Owners")).toBeInTheDocument(); expect(screen.getByText("Messages")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter", code: "Enter", keyCode: 13 });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/leads/Home"));
  });
  it("keeps newer content when an earlier request resolves last", async () => {
    const old = deferred(); vi.mocked(fetch).mockImplementationOnce(() => old.promise as unknown as Promise<Response>);
    open(); type("older"); await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    type("newer"); await screen.findByText("New");
    await act(async () => old.resolve(response([row("Old")])));
    expect(screen.queryByText("Old")).not.toBeInTheDocument(); expect(screen.getByText("New")).toBeInTheDocument();
  });
  it.each(["clear", "close"])("rejects an old response across %s", async action => {
    const old = deferred(); vi.mocked(fetch).mockImplementationOnce(() => old.promise as unknown as Promise<Response>);
    open(); type("older"); await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    if (action === "clear") type(""); else { fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" }); await waitFor(() => expect(screen.queryByRole("combobox")).not.toBeInTheDocument()); fireEvent.click(screen.getByRole("button", { name: "Search" })); }
    await act(async () => old.resolve(response([row("Old")])));
    expect(screen.queryByText("Old")).not.toBeInTheDocument(); expect(screen.getByText("Type at least 3 characters")).toBeInTheDocument();
  });
  it.each(["redirect", "html", "status", "degraded"])("shows unavailable for %s", async kind => {
    const reply = response();
    if (kind === "redirect") reply.redirected = true;
    if (kind === "html") reply.headers = new Headers({ "content-type": "text/html" });
    if (kind === "status") reply.ok = false;
    if (kind === "degraded") reply.json = async () => ({ results: [], degraded: true });
    vi.mocked(fetch).mockResolvedValue(reply as unknown as Response); open(); type("query");
    expect(await screen.findByRole("alert")).toHaveTextContent("Search unavailable");
  });
  it("distinguishes loading and empty results", async () => {
    vi.mocked(fetch).mockResolvedValue(response([]) as unknown as Response); open(); type("nothing");
    expect(screen.getByRole("status")).toHaveTextContent("Searching");
    expect(await screen.findByText("No matches for “nothing”")).toBeInTheDocument();
  });
  it("closes with Escape and restores trigger focus", async () => {
    open(); fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("combobox")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: "Search" })).toHaveFocus());
  });
});
