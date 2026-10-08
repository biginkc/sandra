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
  sequenceId: null,
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

  it("will not save 'On' until a drip is chosen, and never picks one for the owner", async () => {
    const user = userEvent.setup();
    render(<NurtureAutoDripSwitch state={state()} />);
    await user.click(screen.getByRole("button", { name: "Edit nurture auto-drip" }));
    await user.click(screen.getByRole("radio", { name: "On" }));
    expect(screen.getByTestId("nurture-auto-drip-sequence")).toHaveValue("");
    expect(screen.getByRole("alert")).toHaveTextContent("Choose the drip");
    expect(screen.getByTestId("apply-nurture-auto-drip")).toBeDisabled();
  });

  it("saves exactly the on/off and drip the owner chose, then refreshes", async () => {
    const user = userEvent.setup();
    render(<NurtureAutoDripSwitch state={state()} />);
    await user.click(screen.getByRole("button", { name: "Edit nurture auto-drip" }));
    await user.click(screen.getByRole("radio", { name: "On" }));
    await user.selectOptions(screen.getByTestId("nurture-auto-drip-sequence"), "seq-1");
    await user.click(screen.getByTestId("apply-nurture-auto-drip"));
    await waitFor(() => expect(setNurtureAutoDrip).toHaveBeenCalledWith({ configId: "cfg-1", enabled: true, sequenceId: "seq-1" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("shows the current drip when on, and can turn it off", async () => {
    const user = userEvent.setup();
    setNurtureAutoDrip.mockResolvedValue({ ok: true, data: { enabled: false, sequenceId: "seq-1" } });
    render(<NurtureAutoDripSwitch state={state({ enabled: true, sequenceId: "seq-1" })} />);
    expect(screen.getByText("nurture drip [ON: Nurture 12 week]")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Edit nurture auto-drip" }));
    await user.click(screen.getByRole("radio", { name: "Off" }));
    await user.click(screen.getByTestId("apply-nurture-auto-drip"));
    await waitFor(() => expect(setNurtureAutoDrip).toHaveBeenCalledWith({ configId: "cfg-1", enabled: false, sequenceId: "seq-1" }));
  });
});
