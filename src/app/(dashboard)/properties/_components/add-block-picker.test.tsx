import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AddBlockPicker } from "./add-block-picker";

describe("AddBlockPicker", () => {
  it("autofocuses the search input on open", () => {
    render(<AddBlockPicker open onClose={() => {}} onSelect={() => {}} />);
    const input = screen.getByPlaceholderText(/search filters/i);
    expect(input).toHaveFocus();
  });

  it("renders all 6 group headers", () => {
    render(<AddBlockPicker open onClose={() => {}} onSelect={() => {}} />);
    expect(screen.getByText("General")).toBeInTheDocument();
    expect(screen.getByText("Property")).toBeInTheDocument();
    expect(screen.getByText("Owner")).toBeInTheDocument();
    expect(screen.getByText("Value & Equity")).toBeInTheDocument();
    expect(screen.getByText("Status & Engagement")).toBeInTheDocument();
    expect(screen.getByText("Schema-audit additions")).toBeInTheDocument();
  });

  it("typing 'vacan' filters the picker to blocks whose label contains 'vacan'", async () => {
    // delay:null makes userEvent fire all events synchronously so React
    // Strict Mode cannot insert an unmount/remount cycle between keystrokes
    // (which would reset the inner component's q state to "").
    const user = userEvent.setup({ delay: null });
    render(<AddBlockPicker open onClose={() => {}} onSelect={() => {}} />);
    const input = screen.getByPlaceholderText(/search filters/i);
    await user.type(input, "vacan");
    // 'Vacancy' contains 'vacan' (case-insensitive substring match)
    expect(screen.getByText("Vacancy")).toBeInTheDocument();
    // 'List' label does not contain 'vacan', so it is filtered out
    expect(screen.queryByText("List")).not.toBeInTheDocument();
  });

  it("calls onSelect with the block kind when a block is clicked", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<AddBlockPicker open onClose={() => {}} onSelect={onSelect} />);
    await user.click(screen.getByText("Vacancy"));
    expect(onSelect).toHaveBeenCalledWith("vacancy");
  });

  it("Esc calls onClose", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<AddBlockPicker open onClose={onClose} onSelect={() => {}} />);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("does not render when open=false", () => {
    render(<AddBlockPicker open={false} onClose={() => {}} onSelect={() => {}} />);
    expect(screen.queryByPlaceholderText(/search filters/i)).not.toBeInTheDocument();
  });

  it("clicking back arrow calls onClose", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<AddBlockPicker open onClose={onClose} onSelect={() => {}} />);
    await user.click(screen.getByLabelText(/back/i));
    expect(onClose).toHaveBeenCalled();
  });
});
