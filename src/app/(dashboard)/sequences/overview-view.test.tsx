import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { DripsOverview } from "./overview-view";
import type { SequenceRow } from "./actions";

vi.mock("./row-actions", () => ({ SequenceRowActions: () => <span>Row actions</span> }));

const row: SequenceRow = { id: "s1", name: "Seller follow-up", description: null, active: true, append_opt_out: true, archived_at: null, created_at: "2026-09-29", step_count: 4, active_enrollment_count: 13, waiting: 11, replied: 7, finished_no_reply: 5, couldnt_send: 3, stopped: 0 };
const needs = { ok: true as const, data: [
  ...Array.from({ length: 5 }, (_, i) => ({ property_id: `f${i}`, sequence_id: "s1", bucket: "finished_no_reply" as const, reason: "Finished, no reply" })),
  ...Array.from({ length: 3 }, (_, i) => ({ property_id: `c${i}`, sequence_id: "s1", bucket: "couldnt_send" as const, reason: "Couldn’t send" })),
  { property_id: "p1", sequence_id: null, bucket: "needs_sequence" as const, reason: "Needs a drip" },
] };

it("renders RPC metrics in the matching list columns and attention boxes", () => {
  render(<DripsOverview archived={false} isAdmin sequencesResult={{ ok: true, data: [row] }} needsResult={needs} />);
  expect(screen.getByRole("row", { name: /Seller follow-up/ })).toHaveTextContent("13");
  expect(screen.getByRole("row", { name: /Seller follow-up/ })).toHaveTextContent("7");
  expect(screen.getByRole("link", { name: /Finished, no reply\s*5/ })).toHaveAttribute("href", "/sequences/needs-person#finished-no-reply");
  expect(screen.getByRole("link", { name: /Texts couldn’t send\s*3/ })).toHaveAttribute("href", "/sequences/needs-person#couldnt-send");
  expect(screen.getByRole("link", { name: /Needs a drip, none picked yet\s*1/ })).toHaveAttribute("href", "/sequences/needs-person#needs-drip");
});

it("handles empty, error, and archived states", () => {
  const { rerender } = render(<DripsOverview archived={false} isAdmin sequencesResult={{ ok: true, data: [] }} needsResult={{ ok: true, data: [] }} />);
  expect(screen.getByText("No drips yet. Create one to get started.")).toBeInTheDocument();
  rerender(<DripsOverview archived={false} isAdmin sequencesResult={{ ok: false, error: { code: "TEST", message: "offline" } }} needsResult={{ ok: true, data: [] }} />);
  expect(screen.getByRole("alert")).toHaveTextContent("offline");
  rerender(<DripsOverview archived isAdmin sequencesResult={{ ok: true, data: [{ ...row, archived_at: "2026-09-29" }] }} needsResult={{ ok: true, data: [] }} />);
  expect(screen.getByText("Archived drips")).toBeInTheDocument();
  expect(screen.getByRole("row", { name: /Seller follow-up/ })).toBeInTheDocument();
});
