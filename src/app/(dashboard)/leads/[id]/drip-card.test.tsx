import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DripProgress } from "@/lib/sequences/drip-progress";
import { DripCard } from "./drip-card";

const { pauseEnrollmentAction, resumeEnrollmentAction, retrySequenceStepAction, cancelEnrollment, changeDripAction, listDripProgress, pickResult } = vi.hoisted(() => ({
  pauseEnrollmentAction: vi.fn().mockResolvedValue({ ok: true, data: null }),
  resumeEnrollmentAction: vi.fn().mockResolvedValue({ ok: true, data: null }),
  retrySequenceStepAction: vi.fn().mockResolvedValue({ ok: true, data: null }),
  cancelEnrollment: vi.fn().mockResolvedValue({ ok: true, data: null }),
  changeDripAction: vi.fn().mockResolvedValue({ ok: true, data: { status: "skipped", reason: "Already enrolled" } }),
  listDripProgress: vi.fn().mockResolvedValue([]),
  pickResult: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/(dashboard)/sequences/actions", () => ({ pauseEnrollmentAction, resumeEnrollmentAction, retrySequenceStepAction, cancelEnrollment, changeDripAction, startDripForLeads: vi.fn() }));
vi.mock("@/lib/sequences/drip-progress", () => ({ listDripProgress }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@/lib/errors/call-action", () => ({ callAction: (promise: Promise<unknown>) => promise }));
vi.mock("@/components/sequences/start-drip-picker", () => ({ StartDripPicker: ({ triggerLabel, onChoose }: { triggerLabel: string; onChoose: (id: string) => Promise<unknown> }) => <button onClick={() => void onChoose("drip-2").then(pickResult)}>{triggerLabel}</button> }));

const progress: DripProgress = {
  propertyId: "lead-1", enrollmentId: "enrollment-1", enrollmentStatus: "active", sequenceId: "drip-1",
  sequenceName: "90-day follow-up", step: 2, totalSteps: 4,
  nextTextAt: "2026-10-09T14:00:00Z", lastText: { sentAt: "2026-09-29T14:02:00Z", preview: "Hello" },
  status: "Waiting", reason: null,
};

describe("DripCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listDripProgress.mockResolvedValue([]);
    changeDripAction.mockResolvedValue({ ok: true, data: { status: "skipped", reason: "Already enrolled" } });
  });
  it("shows an active drip with progress and controls", () => {
    render(<DripCard propertyId="lead-1" initialProgress={progress} />);
    expect(screen.getByText("90-day follow-up")).toBeInTheDocument();
    expect(screen.getByText("text 2 of 4")).toBeInTheDocument();
    expect(screen.getByText("Next text")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Switch drip" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
  });

  it("shows paused and the reason when status is null", () => {
    render(<DripCard propertyId="lead-1" initialProgress={{ ...progress, enrollmentStatus: "paused", status: null, reason: "Drip was paused by a person." }} />);
    expect(screen.getByText("Paused")).toBeInTheDocument();
    expect(screen.getByText("Drip was paused by a person.")).toBeInTheDocument();
    expect(screen.queryByText("Waiting")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
  });

  it("resumes the shown paused enrollment", async () => {
    const user = userEvent.setup();
    render(<DripCard propertyId="lead-1" initialProgress={{ ...progress, enrollmentStatus: "paused", status: null }} />);
    await user.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(resumeEnrollmentAction).toHaveBeenCalledWith("enrollment-1"));
    expect(retrySequenceStepAction).not.toHaveBeenCalled();
  });

  it.each(["provider_failed", "reconciliation_required"])("retries a paused %s step instead of resuming", async (pauseReason) => {
    const user = userEvent.setup();
    render(<DripCard propertyId="lead-1" initialProgress={{ ...progress, enrollmentStatus: "paused", status: "Couldn’t send", pauseReason }} />);
    expect(screen.queryByRole("button", { name: "Resume" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(retrySequenceStepAction).toHaveBeenCalledWith("enrollment-1"));
    expect(resumeEnrollmentAction).not.toHaveBeenCalled();
  });

  it("shows the empty state", () => {
    render(<DripCard propertyId="lead-1" initialProgress={null} />);
    expect(screen.getByText("Not in a drip")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start drip" })).toBeInTheDocument();
  });

  it("offers a new drip after a completed reply, without trying to change a finished enrollment", () => {
    render(<DripCard propertyId="lead-1" initialProgress={{ ...progress, enrollmentStatus: "completed", status: "Replied", nextTextAt: null }} />);
    expect(screen.getByText("Replied")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start drip" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Switch drip" })).not.toBeInTheDocument();
  });

  it("pauses and stops only the shown enrollment", async () => {
    const user = userEvent.setup();
    listDripProgress.mockResolvedValue([progress]);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<DripCard propertyId="lead-1" initialProgress={progress} />);
    await user.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(pauseEnrollmentAction).toHaveBeenCalledWith("enrollment-1"));
    await user.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(cancelEnrollment).toHaveBeenCalledWith("enrollment-1"));
  });

  it("switches through the guarded change action", async () => {
    const user = userEvent.setup();
    listDripProgress.mockResolvedValue([{ ...progress, enrollmentStatus: "completed", status: "Stopped", nextTextAt: null }]);
    changeDripAction.mockResolvedValue({ ok: true, data: { status: "skipped", reason: "Previous drip stopped. No consent." } });
    render(<DripCard propertyId="lead-1" initialProgress={progress} />);
    await user.click(screen.getByRole("button", { name: "Switch drip" }));
    expect(changeDripAction).toHaveBeenCalledWith("enrollment-1", "drip-2");
    await waitFor(() => expect(listDripProgress).toHaveBeenCalledWith(expect.anything(), ["lead-1"]));
    expect(await screen.findByText("Stopped")).toBeInTheDocument();
    expect(pickResult).toHaveBeenCalledWith({ status: "skipped", reason: "Previous drip stopped. No consent.", saved: false });
  });
});
