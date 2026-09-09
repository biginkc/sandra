import React from "react";
import { act, fireEvent, render, screen, waitFor, cleanup, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
import { GlobalSearchProvider } from "./global-search-provider";
import { GlobalSearchTrigger } from "./global-search-trigger";
import styles from "./global-search.module.css";
const GlobalSearch = () => <GlobalSearchProvider><GlobalSearchTrigger /></GlobalSearchProvider>;
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
describe("§12 global search regression", () => {
  it("fills the viewport and renders all fifteen results in ordered groups", async () => {
    const results = ["property", "owner", "thread"].flatMap(kind =>
      Array.from({ length: 5 }, (_, i) => row(`${kind} ${i + 1}`, kind)));
    vi.mocked(fetch).mockResolvedValue(response(results) as unknown as Response);
    open(); type("query");
    await screen.findByText("thread 5");
    expect(screen.getByRole("dialog")).toHaveClass(styles.layer);
    expect(screen.getByRole("listbox").parentElement?.parentElement).toHaveClass(styles.body);
    expect(screen.getAllByRole("option")).toHaveLength(15);
    const headings = Array.from(screen.getByRole("dialog").querySelectorAll("[role=group] > div > span[id]"));
    expect(headings.map(heading => heading.textContent)).toEqual(["Properties", "Owners", "Messages"]);
    for (const label of ["Properties", "Owners", "Messages"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });
  it("closes with the visible close button and restores trigger focus", async () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "Close search" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: "Search" })).toHaveFocus());
  });
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

describe("redesign interaction contracts", () => {
  it.each(["metaKey", "ctrlKey"])("§12/1 %s toggles uppercase K and prevents browser default", async modifier => {
    render(<GlobalSearch />);
    const first = new KeyboardEvent("keydown", { key: "K", [modifier]: true, bubbles: true, cancelable: true });
    act(() => { window.dispatchEvent(first); });
    expect(first.defaultPrevented).toBe(true); await waitFor(() => expect(screen.getByRole("combobox")).toHaveFocus());
    const second = new KeyboardEvent("keydown", { key: "k", [modifier]: true, bubbles: true, cancelable: true });
    act(() => { window.dispatchEvent(second); });
    expect(second.defaultPrevented).toBe(true); await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
  it("§12/2 reopen resets populated input; a pending focus return cannot steal focus", async () => {
    open(); type("query"); await screen.findByRole("option");
    fireEvent.click(screen.getByRole("button", { name: "Close search" }));
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(screen.getByRole("combobox")).toHaveValue(""); expect(screen.getByRole("combobox")).toHaveFocus(); expect(screen.getByText("Type at least 3 characters")).toBeVisible(); expect(screen.queryByRole("option")).toBeNull();
  });
  it("§12/3 accessible input retains cap and text-entry settings; examples are static", () => {
    open(); const input = screen.getByRole("combobox", { name: "Search" });
    expect(input).toHaveAttribute("maxlength", "100"); expect(input).toHaveAttribute("autocomplete", "off"); expect(input).toHaveAttribute("autocorrect", "off"); expect(input).toHaveAttribute("spellcheck", "false"); expect(input).toHaveAttribute("aria-autocomplete", "list"); expect(input).toHaveAttribute("aria-expanded", "true"); expect(input).toHaveAttribute("aria-controls", screen.getByRole("listbox").id);
    for (const hint of ["816 555 1234", "907 N Jerry", "Raymore", "64083", "marisol.h@gmail.com", '"still own"']) expect(screen.getByText(hint).tagName).toBe("SPAN");
  });
  it.each(["phone", "email"])("§12/9 preserves visible %s matched-field owner badge and verbatim secondary", async matchedField => {
    vi.mocked(fetch).mockResolvedValue(response([{ ...row("Owner", "owner"), matchedField, subtitle: "actual@production.test" }]) as unknown as Response);
    open(); type("query"); const option = await screen.findByRole("option");
    expect(within(option).getByText(matchedField)).toBeVisible(); expect(within(option).getByText("actual@production.test")).toBeVisible();
    expect(screen.queryByText("Properties")).toBeNull(); expect(screen.queryByText("Messages")).toBeNull(); expect(screen.getByRole("status")).toHaveTextContent("1 result"); expect(screen.getByRole("group", { name: "Owners" })).toBeVisible();
  });
  it("§12/9 groups preserve order and distinct duplicate titles, blank and escaped secondary text", async () => {
    vi.mocked(fetch).mockResolvedValue(response([
      { ...row("Same", "thread"), subtitle: "<b>literal message</b>" },
      { ...row("Same", "owner"), subtitle: "" },
      { ...row("Same"), subtitle: "City ST ZIP" },
    ]) as unknown as Response);
    open(); type("query"); await screen.findAllByRole("option");
    const options = screen.getAllByRole("option"); expect(options).toHaveLength(3); expect(new Set(options.map(option => option.id)).size).toBe(3);
    expect(options[0]).toHaveTextContent("City ST ZIP"); expect(options[1]).not.toHaveTextContent("Subtitle"); expect(options[2]).toHaveTextContent("<b>literal message</b>"); expect(options[2].querySelector("b")).toBeNull(); expect(within(options[2]).getByText("<b>literal message</b>")).toHaveAttribute("data-message", "true");
    expect(screen.getByRole("status")).toHaveTextContent("3 results");
  });
  it.each([
    ["property", "/leads/property-id"], ["owner", "/leads/linked-property"],
    ["owner", "/messages?thread=owner-thread"], ["thread", "/messages?thread=message-thread"],
  ])("§12/12 %s destination %s passes through on click and Enter", async (kind, href) => {
    vi.mocked(fetch).mockResolvedValue(response([{ ...row("Destination", kind), href }]) as unknown as Response);
    open(); type("query"); fireEvent.click(await screen.findByRole("option")); expect(push).toHaveBeenLastCalledWith(href); expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Search" })); type("query"); await screen.findByRole("option"); fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" }); expect(push).toHaveBeenCalledTimes(2); expect(push).toHaveBeenLastCalledWith(href); expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("§12/12 arrows clamp across groups, hover preserves focus, and committed results reset selection", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response([row("Home"), row("Ada", "owner"), row("SMS", "thread")]) as unknown as Response);
    open(); type("query"); await screen.findByText("Home"); const input = screen.getByRole("combobox"); const options = screen.getAllByRole("option");
    const selected = (index: number) => { expect(options[index]).toHaveAttribute("aria-selected", "true"); expect(input).toHaveAttribute("aria-activedescendant", options[index].id); };
    selected(0); fireEvent.keyDown(input, { key: "ArrowUp" }); selected(0);
    fireEvent.keyDown(input, { key: "ArrowDown" }); selected(1); fireEvent.keyDown(input, { key: "ArrowDown" }); selected(2); fireEvent.keyDown(input, { key: "ArrowDown" }); selected(2);
    fireEvent.mouseEnter(options[0]); selected(0); expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: "ArrowDown" }); type("newer"); selected(1); await screen.findByText("New"); expect(screen.getByRole("option")).toHaveAttribute("aria-selected", "true");
  });
  it.each([
    ["End", {}, 3], ["Home", {}, 0], ["ArrowDown", { metaKey: true }, 3], ["ArrowUp", { metaKey: true }, 0],
    ["n", { ctrlKey: true }, 1], ["j", { ctrlKey: true }, 1], ["p", { ctrlKey: true }, 0],
    ["ArrowDown", { altKey: true }, 2], ["ArrowUp", { altKey: true }, 0],
  ])("§12/12 keyboard parity %s %j", async (key, modifiers, target) => {
    vi.mocked(fetch).mockResolvedValue(response([row("one"), row("two"), row("owner", "owner"), row("message", "thread")]) as unknown as Response);
    open(); type("query"); await screen.findAllByRole("option"); const input = screen.getByRole("combobox");
    if (key === "Home" || key === "p" || key === "ArrowUp") fireEvent.mouseEnter(screen.getAllByRole("option")[key === "ArrowUp" ? 2 : 1]);
    fireEvent.keyDown(input, { key, ...modifiers }); expect(screen.getAllByRole("option")[target]).toHaveAttribute("aria-selected", "true");
  });
  it("§12/12 IME and empty Enter do not navigate; Clear and Close keep their own keyboard action", async () => {
    open(); const input = screen.getByRole("combobox"); fireEvent.keyDown(input, { key: "Enter" }); expect(push).not.toHaveBeenCalled(); type("query"); await screen.findByRole("option");
    fireEvent.keyDown(input, { key: "Enter", isComposing: true }); fireEvent.keyDown(input, { key: "Enter", keyCode: 229 }); expect(push).not.toHaveBeenCalled();
    const clear = screen.getByRole("button", { name: "Clear" }); fireEvent.keyDown(clear, { key: "Enter" }); expect(push).not.toHaveBeenCalled(); fireEvent.click(clear); expect(input).toHaveValue(""); expect(input).toHaveFocus(); expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
    const close = screen.getByRole("button", { name: "Close search" }); fireEvent.keyDown(close, { key: "Enter" }); expect(push).not.toHaveBeenCalled(); fireEvent.click(close); expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("§12/12 selection changes only list scrollTop, never scrollIntoView", async () => {
    vi.mocked(fetch).mockResolvedValue(response([row("one"), row("two")]) as unknown as Response); open(); type("query"); await screen.findAllByRole("option");
    const list = screen.getByRole("listbox").parentElement!.parentElement!;
    vi.spyOn(list, "getBoundingClientRect").mockReturnValue({ top: 100, bottom: 300 } as DOMRect); Object.defineProperty(list, "clientHeight", { configurable: true, value: 200 });
    const options = screen.getAllByRole("option"); vi.spyOn(options[1], "getBoundingClientRect").mockReturnValue({ top: 290, bottom: 350 } as DOMRect);
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" }); expect(list.scrollTop).toBe(50);
    vi.spyOn(options[0], "getBoundingClientRect").mockReturnValue({ top: 70, bottom: 126 } as DOMRect);
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowUp" }); expect(list.scrollTop).toBe(20); expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });
  it.each([["MacIntel", "⌘ K"], ["iPhone", "⌘ K"], ["Win32", "Ctrl K"]])("§12/1 platform %s uses %s after mount", (platform, label) => {
    vi.spyOn(window.navigator, "platform", "get").mockReturnValue(platform); render(<GlobalSearch />); expect(screen.getByText(label)).toBeVisible(); vi.restoreAllMocks();
  });
});
