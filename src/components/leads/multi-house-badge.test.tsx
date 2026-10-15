import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HomeownerHouses } from "@/lib/leads/homeowner-houses";
const loadMore = vi.hoisted(() => vi.fn());
vi.mock("@/lib/leads/homeowner-houses-action", () => ({ loadMoreHomeownerHousesAction: loadMore }));

import { MultiHouseBadge } from "./multi-house-badge";

const C1 = "11111111-1111-4111-8111-111111111111";
const house = (n: number) => ({
  propertyId: `p${String(n).padStart(3, "0")}`,
  address: `${n} Oak St, Kansas City, MO`,
  assignedUserId: "me",
  isMine: true,
});
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => house(from + i));

beforeEach(() => {
  loadMore.mockReset();
});

const houses: HomeownerHouses = {
  count: 3,
  houses: [
    { propertyId: "p1", address: "1 Oak St, Kansas City, MO", assignedUserId: "me", isMine: true },
    { propertyId: "p2", address: "2 Elm St, Olathe, KS", assignedUserId: "rep", isMine: false },
    { propertyId: "p3", address: "3 Ash St, Lenexa, KS", assignedUserId: "me", isMine: true },
  ],
};

describe("MultiHouseBadge", () => {
  it("is hidden when the homeowner owns one house or the count is unknown", () => {
    const { container, rerender } = render(<MultiHouseBadge houses={{ count: 1, houses: houses.houses.slice(0, 1) }} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<MultiHouseBadge houses={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the count as a button with a clear accessible name", () => {
    render(<MultiHouseBadge houses={{ ...houses, count: 2 }} ownerName="Pat Lee" />);
    const badge = screen.getByRole("button", { name: "Owns 2 houses. Show Pat Lee's houses" });
    expect(badge).toHaveTextContent("Owns 2 houses");
  });

  it("lists every address as a link to its lead, labelling another rep's lead", async () => {
    render(<MultiHouseBadge houses={houses} ownerName="Pat Lee" currentPropertyId="p3" />);
    await userEvent.click(screen.getByRole("button", { name: /Owns 3 houses/ }));
    const list = await screen.findByRole("list", { name: "Pat Lee's houses" });
    const links = within(list).getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["/leads/p1", "/leads/p2", "/leads/p3"]);
    expect(links[0]).toHaveTextContent("1 Oak St, Kansas City, MO");
    expect(links[0]).not.toHaveTextContent("another rep's lead");
    expect(links[1]).toHaveTextContent("2 Elm St, Olathe, KSanother rep's lead");
    expect(links[2]).toHaveTextContent("This lead");
    expect(links[2]).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("Pat Lee owns 3 houses")).toBeInTheDocument();
  });

  it("opens from the keyboard", async () => {
    render(<MultiHouseBadge houses={houses} />);
    await userEvent.tab();
    expect(screen.getByRole("button", { name: /Owns 3 houses/ })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByRole("list", { name: "This homeowner's houses" })).toBeInTheDocument();
  });

  it("offers Show more past the first page and reaches houses 51 to 60", async () => {
    loadMore.mockResolvedValue({ ok: true, houses: range(51, 60), count: 60, nextOffset: null });
    render(<MultiHouseBadge houses={{ count: 60, houses: range(1, 50) }} contactId={C1} />);
    await userEvent.click(screen.getByRole("button", { name: /Owns 60 houses/ }));
    expect(await screen.findByText("Showing 50 of 60.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(loadMore).toHaveBeenCalledWith({ contactId: C1, offset: 50 });
    const list = await screen.findByRole("list");
    await waitFor(() => expect(within(list).getAllByRole("link")).toHaveLength(60));
    expect(within(list).getByText("60 Oak St, Kansas City, MO")).toBeInTheDocument();
    // Focus lands on the first newly listed house, and the control goes away once every house is listed.
    expect(screen.getByTestId("multi-house-badge-house-p051")).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Showing/)).not.toBeInTheDocument();
  });

  it("keeps paging until the end for a very large owner", async () => {
    loadMore.mockImplementation(async ({ offset }: { offset: number }) => {
      const end = Math.min(offset + 50, 120);
      return { ok: true, houses: range(offset + 1, end), count: 120, nextOffset: end < 120 ? end : null };
    });
    render(<MultiHouseBadge houses={{ count: 120, houses: range(1, 50) }} contactId={C1} />);
    await userEvent.click(screen.getByRole("button", { name: /Owns 120 houses/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Show more" }));
    await screen.findByText("Showing 100 of 120.");
    await userEvent.click(screen.getByRole("button", { name: "Show more" }));
    await waitFor(() => expect(within(screen.getByRole("list")).getAllByRole("link")).toHaveLength(120));
    expect(loadMore.mock.calls.map(([input]) => input.offset)).toEqual([50, 100]);
  });

  it("shows an error and keeps Show more when a page fails", async () => {
    loadMore.mockResolvedValue({ ok: false, message: "More houses could not load. Try again." });
    render(<MultiHouseBadge houses={{ count: 60, houses: range(1, 50) }} contactId={C1} />);
    await userEvent.click(screen.getByRole("button", { name: /Owns 60 houses/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Show more" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("More houses could not load. Try again.");
    expect(screen.getByRole("button", { name: "Show more" })).toBeEnabled();
  });

  it("says the list is unavailable when it has a count but no houses and cannot load them", async () => {
    render(<MultiHouseBadge houses={{ count: 3, houses: [] }} />);
    await userEvent.click(screen.getByRole("button", { name: /Owns 3 houses/ }));
    expect(await screen.findByText("List unavailable.")).toBeInTheDocument();
  });

  it("is at least 24px tall to tap on a phone", () => {
    render(<MultiHouseBadge houses={houses} />);
    expect(screen.getByRole("button", { name: /Owns 3 houses/ })).toHaveClass("min-h-6");
  });

  it("starts a fresh list when the homeowner changes", async () => {
    loadMore.mockResolvedValue({ ok: true, houses: range(51, 60), count: 60, nextOffset: null });
    const { rerender } = render(<MultiHouseBadge houses={{ count: 60, houses: range(1, 50) }} contactId={C1} />);
    await userEvent.click(screen.getByRole("button", { name: /Owns 60 houses/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Show more" }));
    await waitFor(() => expect(within(screen.getByRole("list")).getAllByRole("link")).toHaveLength(60));
    const other = "22222222-2222-4222-8222-222222222222";
    rerender(<MultiHouseBadge houses={{ count: 2, houses: range(901, 902) }} contactId={other} />);
    await waitFor(() => expect(within(screen.getByRole("list")).getAllByRole("link")).toHaveLength(2));
  });
});
