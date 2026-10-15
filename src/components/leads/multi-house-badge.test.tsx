import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { HomeownerHouses } from "@/lib/leads/homeowner-houses";
import { MultiHouseBadge } from "./multi-house-badge";

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
});
