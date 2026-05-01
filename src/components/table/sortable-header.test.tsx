import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { describe, it, expect, vi } from "vitest";

import { SortableHeader } from "./sortable-header";
import type { SortDirection } from "./use-table-url-state";

type TestColumn = "address" | "name" | "created_at";

type HeaderOverrides = Partial<{
  column: TestColumn;
  current: TestColumn | string;
  dir: SortDirection;
  testIdPrefix: string;
}>;

function renderHeader(props: HeaderOverrides = {}) {
  const onClick = vi.fn();
  const result = render(
    <table>
      <thead>
        <tr>
          <SortableHeader<TestColumn>
            column={props.column ?? "address"}
            current={props.current ?? "address"}
            dir={props.dir ?? "asc"}
            onClick={onClick}
            testIdPrefix={props.testIdPrefix}
          >
            Address
          </SortableHeader>
        </tr>
      </thead>
    </table>,
  );
  return { ...result, onClick };
}

describe("<SortableHeader />", () => {
  it("clicking the header button fires onClick(column) once", async () => {
    const user = userEvent.setup();
    const { onClick } = renderHeader({ testIdPrefix: "t" });
    await user.click(screen.getByTestId("t-sort-address"));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledWith("address");
  });

  it("active + dir='asc' renders aria-sort='ascending' and the ArrowUp icon", () => {
    renderHeader({ current: "address", dir: "asc", testIdPrefix: "t" });
    const button = screen.getByTestId("t-sort-address");
    expect(button).toHaveAttribute("aria-sort", "ascending");
    // lucide ArrowUp renders as <svg class="lucide lucide-arrow-up ...">
    const svg = button.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("class") ?? "").toMatch(/arrow-up/);
  });

  it("active + dir='desc' renders aria-sort='descending' and the ArrowDown icon", () => {
    renderHeader({ current: "address", dir: "desc", testIdPrefix: "t" });
    const button = screen.getByTestId("t-sort-address");
    expect(button).toHaveAttribute("aria-sort", "descending");
    const svg = button.querySelector("svg");
    expect(svg?.getAttribute("class") ?? "").toMatch(/arrow-down/);
  });

  it("inactive (current !== column) renders aria-sort='none' and the ArrowUpDown icon", () => {
    renderHeader({ current: "name", dir: "desc", testIdPrefix: "t" });
    const button = screen.getByTestId("t-sort-address");
    expect(button).toHaveAttribute("aria-sort", "none");
    const svg = button.querySelector("svg");
    expect(svg?.getAttribute("class") ?? "").toMatch(/arrow-up-down/);
  });

  it("testIdPrefix='prospects' produces data-testid='prospects-sort-address'", () => {
    renderHeader({ testIdPrefix: "prospects" });
    expect(screen.getByTestId("prospects-sort-address")).toBeInTheDocument();
  });

  it("omitted testIdPrefix produces data-testid='sort-address' (default fallback)", () => {
    renderHeader();
    expect(screen.getByTestId("sort-address")).toBeInTheDocument();
  });
});
