import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NurtureAutoDripSwitch, type NurtureAutoDripState } from "./nurture-auto-drip-switch";

const { setNurtureAutoDrip, refresh } = vi.hoisted(() => ({ setNurtureAutoDrip: vi.fn(), refresh: vi.fn() }));
vi.mock("./threshold-actions", () => ({ setNurtureAutoDrip }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

const state = (over: Partial<NurtureAutoDripState> = {}): NurtureAutoDripState => ({
  configId: "cfg-1",
  enabled: false,
  drips: { maybeLater: null, checkIn60: null, listedNotSelling: null, hotBookAppointment: null },
  sequences: [
    { id: "seq-1", name: "Nurture 12 week" },
    { id: "seq-2", name: "Other" },
  ],
  ...over,
});

beforeEach(() => {
  setNurtureAutoDrip.mockReset();
  refresh.mockReset();
  setNurtureAutoDrip.mockResolvedValue({ ok: true, data: { enabled: true, sequenceId: "seq-1" } });
});

describe("<NurtureAutoDripSwitch />", () => {
  it("shows OFF by default and changes nothing until the owner saves", async () => {
    const user = userEvent.setup();
    render(<NurtureAutoDripSwitch state={state()} />);
    expect(screen.getByText("nurture drip [OFF]")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Edit nurture auto-drip" }));
    expect(screen.getByRole("radio", { name: "Off" })).toBeChecked();
    expect(screen.getByTestId("apply-nurture-auto-drip")).toBeDisabled();
    expect(setNurtureAutoDrip).not.toHaveBeenCalled();
  });

  const ALL = { maybeLater: "seq-1", checkIn60: "seq-2", listedNotSelling: "seq-3", hotBookAppointment: "seq-4" };
  const FOUR = [
    { id: "seq-1", name: "Nurture 12 week" },
    { id: "seq-2", name: "Other" },
    { id: "seq-3", name: "Third" },
    { id: "seq-4", name: "Fourth" },
  ];

  it("will not save 'On' until all four drips are chosen, and never picks one for the owner", async () => {
    const user = userEvent.setup();
    render(<NurtureAutoDripSwitch state={state()} />);
    await user.click(screen.getByRole("button", { name: "Edit nurture auto-drip" }));
    await user.click(screen.getByRole("radio", { name: "On" }));
    for (const key of ["maybeLater", "checkIn60", "listedNotSelling", "hotBookAppointment"]) {
      expect(screen.getByTestId(`nurture-auto-drip-${key}`)).toHaveValue("");
    }
    expect(screen.getByRole("alert")).toHaveTextContent("Choose all four drips");
    expect(screen.getByTestId("apply-nurture-auto-drip")).toBeDisabled();
    // Three of four is still not enough.
    await user.selectOptions(screen.getByTestId("nurture-auto-drip-maybeLater"), "seq-1");
    await user.selectOptions(screen.getByTestId("nurture-auto-drip-checkIn60"), "seq-2");
    await user.selectOptions(screen.getByTestId("nurture-auto-drip-listedNotSelling"), "seq-3");
    expect(screen.getByTestId("apply-nurture-auto-drip")).toBeDisabled();
  });

  it("pre-selects drips whose names match the defaults exactly (and only exactly), but saves nothing until the owner does", async () => {
    const user = userEvent.setup();
    const sequences = [
      { id: "a", name: "Maybe later" },
      { id: "b", name: "Check in every 60 days" },
      { id: "c", name: "Listed, not selling" },
      { id: "d", name: "Book appointment" },
      { id: "e", name: "maybe later (old)" },
    ];
    render(<NurtureAutoDripSwitch state={state({ sequences })} />);
    await user.click(screen.getByRole("button", { name: "Edit nurture auto-drip" }));
    expect(screen.getByTestId("nurture-auto-drip-maybeLater")).toHaveValue("a");
    expect(screen.getByTestId("nurture-auto-drip-checkIn60")).toHaveValue("b");
    expect(screen.getByTestId("nurture-auto-drip-listedNotSelling")).toHaveValue("c");
    expect(screen.getByTestId("nurture-auto-drip-hotBookAppointment")).toHaveValue("d");
    expect(setNurtureAutoDrip).not.toHaveBeenCalled();
  });

  it("leaves a route empty when no drip matches the default name", async () => {
    const user = userEvent.setup();
    render(<NurtureAutoDripSwitch state={state()} />);
    await user.click(screen.getByRole("button", { name: "Edit nurture auto-drip" }));
    expect(screen.getByTestId("nurture-auto-drip-maybeLater")).toHaveValue("");
  });

  it("saves exactly the on/off and the four drips the owner chose, then refreshes", async () => {
    const user = userEvent.setup();
    render(<NurtureAutoDripSwitch state={state({ sequences: FOUR })} />);
    await user.click(screen.getByRole("button", { name: "Edit nurture auto-drip" }));
    await user.click(screen.getByRole("radio", { name: "On" }));
    await user.selectOptions(screen.getByTestId("nurture-auto-drip-maybeLater"), "seq-1");
    await user.selectOptions(screen.getByTestId("nurture-auto-drip-checkIn60"), "seq-2");
    await user.selectOptions(screen.getByTestId("nurture-auto-drip-listedNotSelling"), "seq-3");
    await user.selectOptions(screen.getByTestId("nurture-auto-drip-hotBookAppointment"), "seq-4");
    await user.click(screen.getByTestId("apply-nurture-auto-drip"));
    await waitFor(() => expect(setNurtureAutoDrip).toHaveBeenCalledWith({ configId: "cfg-1", enabled: true, drips: ALL }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("can turn it off", async () => {
    const user = userEvent.setup();
    setNurtureAutoDrip.mockResolvedValue({ ok: true, data: { enabled: false, drips: ALL } });
    render(<NurtureAutoDripSwitch state={state({ enabled: true, drips: ALL, sequences: FOUR })} />);
    expect(screen.getByText("nurture drip [ON]")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Edit nurture auto-drip" }));
    await user.click(screen.getByRole("radio", { name: "Off" }));
    await user.click(screen.getByTestId("apply-nurture-auto-drip"));
    await waitFor(() => expect(setNurtureAutoDrip).toHaveBeenCalledWith({ configId: "cfg-1", enabled: false, drips: ALL }));
  });
});
