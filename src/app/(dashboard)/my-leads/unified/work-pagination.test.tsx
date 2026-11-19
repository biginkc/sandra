import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { pageItems, totalPagesFor, WorkPagination } from "./work-pagination";

describe("pageItems", () => {
  it("lists every page up to seven", () => {
    expect(pageItems(1, 1)).toEqual([1]);
    expect(pageItems(3, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
  it("collapses with ellipses and always keeps first and last", () => {
    expect(pageItems(1, 20)).toEqual([1, 2, 3, 4, 5, "gap-right", 20]);
    expect(pageItems(10, 20)).toEqual([1, "gap-left", 9, 10, 11, "gap-right", 20]);
    expect(pageItems(20, 20)).toEqual([1, "gap-left", 16, 17, 18, 19, 20]);
    expect(pageItems(4, 9)).toEqual([1, 2, 3, 4, 5, "gap-right", 9]);
  });
  it("is never longer than seven slots and always contains the current page", () => {
    for (let total = 8; total <= 30; total++) {
      for (let page = 1; page <= total; page++) {
        const items = pageItems(page, total);
        expect(items.length).toBeLessThanOrEqual(7);
        expect(items).toContain(page);
        expect(items[0]).toBe(1);
        expect(items[items.length - 1]).toBe(total);
      }
    }
  });
});

describe("totalPagesFor", () => {
  it("25 per page", () => {
    expect(totalPagesFor(0, 25)).toBe(1);
    expect(totalPagesFor(25, 25)).toBe(1);
    expect(totalPagesFor(26, 25)).toBe(2);
    expect(totalPagesFor(181, 25)).toBe(8);
  });
});

describe("<WorkPagination />", () => {
  it("marks the current page with aria-current and navigates", async () => {
    const onPageChange = vi.fn();
    render(<WorkPagination page={2} totalPages={8} onPageChange={onPageChange} />);
    expect(screen.getByRole("button", { name: "Page 2" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Page 3" })).not.toHaveAttribute("aria-current");
    await userEvent.click(screen.getByRole("button", { name: "Page 5" }));
    expect(onPageChange).toHaveBeenLastCalledWith(5);
    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(onPageChange).toHaveBeenLastCalledWith(3);
    await userEvent.click(screen.getByRole("button", { name: "Previous page" }));
    expect(onPageChange).toHaveBeenLastCalledWith(1);
  });
  it("clicking the current page does nothing", async () => {
    const onPageChange = vi.fn();
    render(<WorkPagination page={2} totalPages={8} onPageChange={onPageChange} />);
    await userEvent.click(screen.getByRole("button", { name: "Page 2" }));
    expect(onPageChange).not.toHaveBeenCalled();
  });
  it("disables Previous on the first page and Next on the last", () => {
    const { rerender } = render(<WorkPagination page={1} totalPages={3} onPageChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next page" })).toBeEnabled();
    rerender(<WorkPagination page={3} totalPages={3} onPageChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
  });
  it("shows ellipses for long ranges", () => {
    render(<WorkPagination page={10} totalPages={20} onPageChange={() => {}} />);
    expect(screen.getAllByTestId("work-pagination-gap")).toHaveLength(2);
  });
  it("disables every control while loading", async () => {
    const onPageChange = vi.fn();
    render(<WorkPagination page={2} totalPages={5} loading onPageChange={onPageChange} />);
    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
    expect(screen.getByRole("navigation")).toHaveAttribute("aria-busy", "true");
    await userEvent.click(screen.getByRole("button", { name: "Page 3" }));
    expect(onPageChange).not.toHaveBeenCalled();
  });
  it("renders nothing for a single page", () => {
    const { container } = render(<WorkPagination page={1} totalPages={1} onPageChange={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
  it("clamps an out-of-range page", () => {
    render(<WorkPagination page={99} totalPages={4} onPageChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Page 4" })).toHaveAttribute("aria-current", "page");
  });
});
