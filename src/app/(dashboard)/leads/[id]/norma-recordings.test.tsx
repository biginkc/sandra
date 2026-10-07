import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NormaRecordings } from "./norma-recordings";

const fetchMock = vi.fn();
beforeEach(() => { vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const mount = () => render(<NormaRecordings requestId="request-1" />);
const respond = (recordings: unknown) => fetchMock.mockResolvedValue(new Response(JSON.stringify({ recordings })));

describe("Norma recordings", () => {
  it("does not request recordings until the rep asks", () => {
    mount();
    expect(screen.getByRole("button", { name: "Load Norma recordings" })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("loads each attempt from the authenticated local endpoint", async () => {
    respond([{ attempt: 1 }, { attempt: 2 }]);
    const { container } = mount();
    fireEvent.click(screen.getByRole("button"));
    await screen.findByText("Norma recording · Attempt 2");
    expect(fetchMock).toHaveBeenCalledWith("/api/norma/requests/request-1/recordings", expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }));
    expect([...container.querySelectorAll("audio")].map((audio) => audio.getAttribute("src"))).toEqual([
      "/api/norma/requests/request-1/recordings/1", "/api/norma/requests/request-1/recordings/2",
    ]);
    expect(container.querySelector("audio")).toHaveAttribute("preload", "none");
  });
  it("explains absence and supports later reload", async () => {
    respond([]);
    mount();
    fireEvent.click(screen.getByRole("button"));
    await screen.findByText("No recording is available for this call yet.");
    respond([{ attempt: 1 }]);
    fireEvent.click(screen.getByRole("button", { name: "Reload recordings" }));
    await screen.findByText("Norma recording · Attempt 1");
  });
  it("handles an expired session without creating an audio player", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "Not signed in" }), { status: 401 }));
    const { container } = mount();
    fireEvent.click(screen.getByRole("button"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Not signed in");
    expect(container.querySelector("audio")).toBeNull();
  });
  it("turns an edge HTML error into a useful message", async () => {
    fetchMock.mockResolvedValue(new Response("<html>gateway details</html>", { status: 502 }));
    mount();
    fireEvent.click(screen.getByRole("button"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to load recordings. Try again.");
  });
  it("rejects malformed attempt metadata", async () => {
    respond([{ attempt: "../../private" }]);
    const { container } = mount();
    fireEvent.click(screen.getByRole("button"));
    await screen.findByText("Unable to load recordings");
    expect(container.querySelector("audio")).toBeNull();
  });
  it("shows media failures and lets the rep retry", async () => {
    respond([{ attempt: 1 }]);
    const { container } = mount();
    fireEvent.click(screen.getByRole("button"));
    await screen.findByText("Norma recording · Attempt 1");
    fireEvent.error(container.querySelector("audio")!);
    expect(screen.getByRole("alert")).toHaveTextContent("Recording unavailable");
    respond([{ attempt: 1 }]);
    fireEvent.click(screen.getByRole("button", { name: "Reload recordings" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
  it("distinguishes persisted pending, unavailable and failed availability without removing playback", async () => {
    respond([{ attempt: 1, state: "pending" }, { attempt: 2, state: "failed" }]);
    const { container } = mount();
    fireEvent.click(screen.getByRole("button"));
    await screen.findByText("Recording is still processing or awaiting an availability check.");
    await screen.findByText("Recording availability could not be checked. Playback may still work; try again later.");
    expect(container.querySelectorAll("audio")).toHaveLength(2);
    respond([{ attempt: 1, state: "unavailable" }]);
    fireEvent.click(screen.getByRole("button", { name: "Reload recordings" }));
    await screen.findByText("No recording was available after repeated checks.");
  });

});
