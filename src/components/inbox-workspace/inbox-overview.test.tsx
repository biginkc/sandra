import { act, render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { InboxOverview } from "./inbox-overview";
vi.mock("./use-access-lease", () => ({ useInboxAccessLease: () => "valid" }));
const identity = { orgId: "org", userId: "user", sessionId: "session", accessEpoch: "1", expiresAt: Date.now() + 60000 };
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it("allows opening the workspace before independent counts finish", async () => {
  let resolve!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(done => { resolve = done; })));
  render(<InboxOverview identity={identity} />);
  expect(screen.getByRole("link", { name: "Open Inbox workspace" })).toHaveAttribute("href", "/inbox");
  expect(screen.getByRole("status")).toHaveTextContent("Loading counts");
  await act(async () => resolve(Response.json({ counts: { all: 40000, unread: 20, needs_outcome: 8, mine: 10, unassigned: 18 }, asOf: new Date().toISOString(), accessEpoch: "1" })));
  await waitFor(() => expect(screen.getByRole("link", { name: "All conversations 40000" })).toHaveAttribute("href", "/inbox?view=all"));
});
it("does not show stale-epoch counts or block workspace entry on count failure", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ accessEpoch: "2", counts: { all: 999 } })));
  render(<InboxOverview identity={identity} />);
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Counts unavailable"));
  expect(screen.queryByText("999")).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Open Inbox workspace" })).toBeVisible();
});

it("clears displayed counts at canonical session expiry", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ accessEpoch: "1", asOf: new Date().toISOString(), counts: { all: 42 } })));
  render(<InboxOverview identity={{ ...identity, expiresAt: Date.now() + 1000 }} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(screen.getByText("42")).toBeVisible();
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(screen.queryByText("42")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Retry counts" })).toBeVisible();
});
it("surfaces a canonical 401/403 on counts as access loss, not a retryable count failure", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 403 })));
  render(<InboxOverview identity={identity} />);
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Your access has changed"));
  expect(screen.getAllByText("—")).toHaveLength(5);
  expect(screen.queryByRole("button", { name: "Retry counts" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Reload overview" })).toBeVisible();
});
it("retries a failed independent count request", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 503 })).mockResolvedValueOnce(Response.json({ accessEpoch: "1", asOf: new Date().toISOString(), counts: { all: 42 } }));
  vi.stubGlobal("fetch", fetcher);
  render(<InboxOverview identity={identity} />);
  fireEvent.click(await screen.findByRole("button", { name: "Retry counts" }));
  await screen.findByText("42");
  expect(fetcher).toHaveBeenCalledTimes(2);
});
