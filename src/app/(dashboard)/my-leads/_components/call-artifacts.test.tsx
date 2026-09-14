import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MyLeadCallArtifacts } from "./call-artifacts";
const base = { recordingStatus: "available", durationSeconds: 51, transcriptStatus: "available", transcript: "Seller transcript", summaryStatus: "failed", summary: null as string | null };
const response = (data = base) => ({ ok: true, json: async () => data }) as Response;
afterEach(() => vi.restoreAllMocks());
describe("independent call artifacts", () => {
  it("shows available audio and transcript despite a failed summary, then refreshes recovered summary", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response()).mockResolvedValueOnce(response({ ...base, summaryStatus: "available", summary: "Seller wants a callback" }));
    render(<MyLeadCallArtifacts callActivityId="call-1" />);
    expect(await screen.findByRole("button", { name: "Load recording (51s)" })).toBeVisible();
    expect(screen.getByText("Summary unavailable. Please reach out to an admin.")).toBeVisible();
    expect(screen.getByText("Seller transcript")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh call details" }));
    expect(await screen.findByText("Seller wants a callback")).toBeVisible();
    expect(screen.queryByText(/Summary unavailable/)).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it.each([["pending", "Recording processing"], ["failed", "Recording unavailable. Please reach out to an admin."], ["none", "No recording captured"]])("distinguishes %s without a playback request", async (state, label) => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(response({ ...base, recordingStatus: state }));
    render(<MyLeadCallArtifacts callActivityId="call-1" />);
    expect(await screen.findByText(label)).toBeVisible();
    expect(screen.queryByRole("button", { name: /Load recording/ })).not.toBeInTheDocument(); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("preserves loaded artifacts when refresh fails and aborts on unmount", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response()).mockRejectedValueOnce(new Error("network"));
    const view = render(<MyLeadCallArtifacts callActivityId="call-1" />);
    await screen.findByText("Transcript"); fireEvent.click(screen.getByRole("button", { name: "Refresh call details" }));
    await screen.findByText("Call details could not be refreshed. Try again.");
    expect(screen.getByRole("button", { name: "Load recording (51s)" })).toBeVisible();
    const signal = fetchMock.mock.calls[1][1]?.signal;
    view.unmount(); await waitFor(() => expect(signal?.aborted).toBe(true));
  });
});
