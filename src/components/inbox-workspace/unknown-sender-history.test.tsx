import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UnknownSenderHistory, type UnknownSenderHistoryProps } from "./unknown-sender-history";
const org = "11111111-1111-1111-1111-111111111111", group = "22222222-2222-2222-2222-222222222222";
function props(): UnknownSenderHistoryProps {
  return { orgId: org, senderGroupId: group, requestGeneration: 1, visible: true, onRefresh: vi.fn(), onAccessLost: vi.fn(), onUnavailable: vi.fn(), fetch: vi.fn<typeof fetch>(),
    snapshot: { requestGeneration: 1, data: { requesterId: org, orgId: org, senderGroupId: group, rawSender: "+1 raw", expiresAt: "2030-01-01T00:00:00Z", nextCursor: org,
      history: [{ id: org, createdAtRaw: "2026-09-13T12:00:00Z", body: "Latest sender message", direction: "inbound", dismissedAtRaw: null }] } } };
}
afterEach(cleanup);
it("renders without any acknowledgment request and hides superseded snapshots", () => {
  const p = props(), view = render(<UnknownSenderHistory {...p} />);
  expect(screen.getByText("Latest sender message")).toBeInTheDocument(); expect(p.fetch).not.toHaveBeenCalled();
  view.rerender(<UnknownSenderHistory {...p} requestGeneration={2} />);
  expect(screen.queryByText("Latest sender message")).not.toBeInTheDocument();
});
it("replaces older pages and restores cached latest without another request", async () => {
  const p = props(); p.fetch = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ...p.snapshot!.data, nextCursor: null,
    history: [{ ...p.snapshot!.data.history[0], id: group, body: "Older sender message" }] }));
  render(<UnknownSenderHistory {...p} />); fireEvent.click(screen.getByText("Load older messages"));
  await screen.findByText("Older sender message"); expect(screen.queryByText("Latest sender message")).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("Back to latest messages")); expect(screen.getByText("Latest sender message")).toBeInTheDocument();
  expect(p.fetch).toHaveBeenCalledOnce();
});
it("clears the pane on access denial and rejects foreign page identity", async () => {
  const p = props(); p.fetch = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ ...p.snapshot!.data, senderGroupId: org })).mockResolvedValueOnce(new Response(null, { status: 401 }));
  render(<UnknownSenderHistory {...p} />); fireEvent.click(screen.getByText("Load older messages"));
  await screen.findByRole("alert"); expect(screen.getByText("Latest sender message")).toBeInTheDocument();
  fireEvent.click(screen.getByText("Load older messages")); await waitFor(() => expect(p.onAccessLost).toHaveBeenCalledOnce());
  expect(screen.queryByText("Latest sender message")).not.toBeInTheDocument();
});
it("signals a benign item-scoped 404 as onUnavailable, not a workspace-wide access loss", async () => {
  const p = props(); p.fetch = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 404 }));
  render(<UnknownSenderHistory {...p} />); fireEvent.click(screen.getByText("Load older messages"));
  await waitFor(() => expect(p.onUnavailable).toHaveBeenCalledExactlyOnceWith(group));
  expect(p.onAccessLost).not.toHaveBeenCalled();
});
it("ignores a late older page after navigation", async () => {
  const p = props(); let resolve!: (response: Response) => void;
  p.fetch = vi.fn<typeof fetch>().mockImplementation(() => new Promise(done => { resolve = done; }));
  const view = render(<UnknownSenderHistory {...p} />); fireEvent.click(screen.getByText("Load older messages"));
  view.rerender(<UnknownSenderHistory {...p} requestGeneration={2} />);
  await act(async () => resolve(Response.json(p.snapshot!.data)));
  expect(screen.queryByText("Latest sender message")).not.toBeInTheDocument();
});
