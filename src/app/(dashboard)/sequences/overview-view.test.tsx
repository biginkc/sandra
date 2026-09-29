import { render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { DripsOverview } from "./overview-view";
import type { SequenceRow } from "./actions";

vi.mock("./row-actions", () => ({ SequenceRowActions: () => <span>Row actions</span> }));

const row: SequenceRow = { id: "s1", name: "Seller follow-up", description: null, active: true, append_opt_out: true, archived_at: null, created_at: "2026-09-29", step_count: 4, active_enrollment_count: 13, waiting: 11, replied: 7, finished_no_reply: 5, couldnt_send: 3, stopped: 0 };
const needs = { ok: true as const, data: { finished_no_reply: 5, couldnt_send: 3, needs_sequence: 1 } };

it("renders RPC metrics in the matching list columns and attention boxes", () => {
  render(<DripsOverview archived={false} isAdmin sequencesResult={{ ok: true, data: [row] }} needsResult={needs} />);
  const headers = within(screen.getByRole("table")).getAllByRole("columnheader");
  const cells = within(screen.getByRole("row", { name: /Seller follow-up/ })).getAllByRole("cell");
  for (const [header, value] of [
    ["Enrolled", "13"],
    ["Replied", "7"],
    ["Finished, no reply", "5"],
    ["Couldn’t send", "3"],
  ]) {
    const index = headers.findIndex((cell) => cell.textContent === header);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(cells[index]).toHaveTextContent(new RegExp(`^${value}$`));
  }
  expect(screen.getByRole("link", { name: /Finished, no reply\s*5/ })).toHaveAttribute("href", "/sequences/needs-person#finished-no-reply");
  expect(screen.getByRole("link", { name: /Texts couldn’t send\s*3/ })).toHaveAttribute("href", "/sequences/needs-person#couldnt-send");
  expect(screen.getByRole("link", { name: /Needs a drip, none picked yet\s*1/ })).toHaveAttribute("href", "/sequences/needs-person#needs-drip");
});

it("handles empty, error, and archived states", () => {
  const { rerender } = render(<DripsOverview archived={false} isAdmin sequencesResult={{ ok: true, data: [] }} needsResult={needs} />);
  expect(screen.getByText("No drips yet. Create one to get started.")).toBeInTheDocument();
  rerender(<DripsOverview archived={false} isAdmin sequencesResult={{ ok: false, error: { code: "TEST", message: "offline" } }} needsResult={needs} />);
  expect(screen.getByRole("alert")).toHaveTextContent("offline");
  rerender(<DripsOverview archived isAdmin sequencesResult={{ ok: true, data: [{ ...row, archived_at: "2026-09-29" }] }} needsResult={needs} />);
  expect(screen.getByText("Archived drips")).toBeInTheDocument();
  expect(screen.getByRole("row", { name: /Seller follow-up/ })).toBeInTheDocument();
});

it("lets a non-admin open read-only drip details without edit actions", () => {
  render(<DripsOverview archived={false} isAdmin={false} sequencesResult={{ ok: true, data: [row] }} needsResult={needs} />);
  expect(screen.getByRole("link", { name: "Seller follow-up" })).toHaveAttribute("href", "/sequences/s1");
  expect(screen.queryByText("Row actions")).not.toBeInTheDocument();
});
