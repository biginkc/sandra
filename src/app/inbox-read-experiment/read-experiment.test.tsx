import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReadExperiment } from "./read-experiment";

const rows = ["A", "B"].map(id => ({ id, name: `Contact ${id}`, address: "Synthetic", preview: `Preview ${id}` }));
const payload = (id: string) => ({ status: "ready", conversationId: id, context: { contactName: `Contact ${id}` },
  freshness: { contextReadCompletedAt: "2026-09-13T00:00:00Z", latestInbound: null },
  messages: [{ id: `message-${id}`, body: `Body ${id}`, direction: "inbound", created_at: "2026-09-13", status: "received" }], nextCursor: null });
const result = (id: string) => ({ ok: true, json: async () => payload(id) });
const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => vi.unstubAllGlobals());

describe("P0 independent read measurement surface", () => {
  it("clears other cached displays when an expired session redirects to HTML", async () => {
    fetchMock.mockResolvedValueOnce(result("A")).mockResolvedValueOnce(result("B"))
      .mockResolvedValueOnce({ ok: true, redirected: true, json: async () => { throw new SyntaxError("HTML login response"); } })
      .mockResolvedValueOnce(result("A"));
    render(<ReadExperiment rows={rows} />);
    fireEvent.click(screen.getAllByTestId("experiment-row")[0]);
    await screen.findByText("Body A");
    fireEvent.click(screen.getAllByTestId("experiment-row")[1]);
    await screen.findByText("Body B");
    fireEvent.click(screen.getByRole("button", { name: "Refresh conversation" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getAllByTestId("experiment-row")[0]);
    await screen.findByText("Body A");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(screen.getByTestId("experiment-detail").dataset.readSource).toBe("network");
  });

  it("loads by a real row click and revisits bounded memory without a network call", async () => {
    fetchMock.mockResolvedValueOnce(result("A")).mockResolvedValueOnce(result("B"));
    render(<ReadExperiment rows={rows} />);
    fireEvent.click(screen.getAllByTestId("experiment-row")[0]);
    await screen.findByText("Body A");
    expect(screen.getByTestId("experiment-detail").dataset.readSource).toBe("network");
    fireEvent.click(screen.getAllByTestId("experiment-row")[1]);
    await screen.findByText("Body B");
    fireEvent.click(screen.getAllByTestId("experiment-row")[0]);
    await screen.findByText("Body A");
    expect(screen.getByTestId("experiment-detail").dataset.readSource).toBe("memory");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/inbox-v2/detail?conversationId=A&pageSize=50");
  });

  it("does not let a slow old response replace the newly opened conversation", async () => {
    let resolveA!: (value: ReturnType<typeof result>) => void;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { resolveA = resolve; })).mockResolvedValueOnce(result("B"));
    render(<ReadExperiment rows={rows} />);
    fireEvent.click(screen.getAllByTestId("experiment-row")[0]);
    fireEvent.click(screen.getAllByTestId("experiment-row")[1]);
    await screen.findByText("Body B");
    await act(async () => resolveA(result("A")));
    expect(screen.queryByText("Body A")).toBeNull();
    expect(screen.getByTestId("experiment-detail").dataset.conversationId).toBe("B");
  });

  it("rejects wrong response identity and permits explicit fresh reads", async () => {
    fetchMock.mockResolvedValueOnce(result("B")).mockResolvedValueOnce(result("A")).mockResolvedValueOnce(result("A"));
    render(<ReadExperiment rows={rows} />);
    fireEvent.click(screen.getAllByTestId("experiment-row")[0]);
    await screen.findByRole("alert");
    expect(screen.queryByTestId("experiment-detail")).toBeNull();
    fireEvent.click(screen.getAllByTestId("experiment-row")[0]);
    await screen.findByText("Body A");
    fireEvent.click(screen.getByRole("button", { name: "Refresh conversation" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await screen.findByText("Body A");
  });

  it("evicts old displays after twenty distinct conversations and clears cache after denied access", async () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ id: String(i), name: `Contact ${i}`, address: null, preview: "Synthetic" }));
    fetchMock.mockImplementation(async (url: string) => result(new URL(url, "http://localhost").searchParams.get("conversationId")!));
    render(<ReadExperiment rows={many} />);
    for (let i = 0; i < 21; i++) {
      fireEvent.click(screen.getAllByTestId("experiment-row")[i]);
      await screen.findByText(`Body ${i}`);
    }
    fireEvent.click(screen.getAllByTestId("experiment-row")[0]);
    await screen.findByText("Body 0");
    expect(fetchMock).toHaveBeenCalledTimes(22);
    fetchMock.mockResolvedValueOnce({ ok: false });
    fireEvent.click(screen.getByRole("button", { name: "Refresh conversation" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getAllByTestId("experiment-row")[20]);
    await screen.findByText("Body 20");
    expect(fetchMock).toHaveBeenCalledTimes(24);
    expect(screen.getByTestId("experiment-detail").dataset.readSource).toBe("network");
  });
});
