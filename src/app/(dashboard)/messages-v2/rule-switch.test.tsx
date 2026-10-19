import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RulesPanel } from "./rules-panel";
import type { AiRuleSwitchState } from "./threshold-actions";

afterEach(cleanup);

const state = (over: Partial<AiRuleSwitchState> = {}): AiRuleSwitchState => ({
  configId: "cfg-1",
  nineIdentityReply: true,
  nineConfirmedOwnerDrip: true,
  classifierEngine: "nine_questions",
  ...over,
});

const open = async (props: Partial<Parameters<typeof RulesPanel>[0]>) => {
  render(<RulesPanel orgId="o" isOwner badges={[]} classifierEngine="nine_questions" {...props} />);
  await userEvent.click(screen.getByTestId("open-rules"));
  return screen.getByTestId("rules-panel");
};

const row = (panel: HTMLElement, title: string) =>
  within(panel).getAllByTestId("rule-row").find((r) => r.textContent?.startsWith(title))!;

describe("rules panel owner switches (PR 4)", () => {
  it("Asked who and Confirmed owner each get their own switch, written through the setter", async () => {
    const action = vi.fn().mockResolvedValue({ ok: true, data: state({ nineIdentityReply: false }) });
    const panel = await open({ ruleSwitches: state(), setRuleSwitch: action });
    const who = row(panel, "Asked who is texting");
    expect(within(who).getByTestId("rule-switch-state-nine_identity_reply")).toHaveTextContent("On");
    expect(within(row(panel, "Confirmed owner")).getByTestId("rule-switch-state-nine_confirmed_owner_drip")).toHaveTextContent("On");
    await userEvent.click(within(who).getByTestId("rule-switch-nine_identity_reply"));
    expect(action).toHaveBeenCalledWith({ configId: "cfg-1", switch: "nine_identity_reply", value: "false" });
    await waitFor(() => expect(within(who).getByTestId("rule-switch-state-nine_identity_reply")).toHaveTextContent("Off"));
  });

  it("fails closed: a refused write keeps the last confirmed state and says why", async () => {
    const action = vi.fn().mockResolvedValue({ ok: false, error: { code: "X", message: "Only an org owner can change this." } });
    const panel = await open({ ruleSwitches: state(), setRuleSwitch: action });
    const owner = row(panel, "Confirmed owner");
    await userEvent.click(within(owner).getByTestId("rule-switch-nine_confirmed_owner_drip"));
    expect(await within(owner).findByRole("alert")).toHaveTextContent("Only an org owner can change this.");
    expect(within(owner).getByTestId("rule-switch-state-nine_confirmed_owner_drip")).toHaveTextContent("On");
  });

  it("non-owners see the state but no switch buttons", async () => {
    const panel = await open({ isOwner: false, ruleSwitches: state({ nineConfirmedOwnerDrip: false }), setRuleSwitch: vi.fn() });
    expect(within(panel).queryByTestId("rule-switch-nine_identity_reply")).toBeNull();
    expect(within(panel).getByTestId("rule-switch-state-nine_confirmed_owner_drip")).toHaveTextContent("Off");
    expect(within(panel).queryByTestId("rule-switch-classifier_engine")).toBeNull();
  });

  it("the engine switch flips the panel to the old rows once the database confirms", async () => {
    const action = vi.fn().mockResolvedValue({ ok: true, data: state({ classifierEngine: "outcome_v1" }) });
    const panel = await open({ ruleSwitches: state(), setRuleSwitch: action });
    expect(within(panel).getByTestId("nine-rules")).toBeTruthy();
    await userEvent.click(within(panel).getByTestId("rule-switch-classifier_engine"));
    expect(action).toHaveBeenCalledWith({ configId: "cfg-1", switch: "classifier_engine", value: "outcome_v1" });
    await waitFor(() => expect(within(panel).queryByTestId("nine-rules")).toBeNull());
    expect(panel.textContent).not.toMatch(/Jev/);
  });
});

describe("concurrent toggles", () => {
  it("a slower, older reply for one switch does not undo a newer change to another", async () => {
    // Identity's reply is slow and was built before the drip change: it reports the drip as still ON.
    let releaseIdentity: (v: unknown) => void = () => {};
    const action = vi.fn((input: { switch: string }) =>
      input.switch === "nine_identity_reply"
        ? new Promise((resolve) => {
            releaseIdentity = resolve;
          })
        : Promise.resolve({ ok: true, data: state({ nineConfirmedOwnerDrip: false }) }),
    );
    const panel = await open({ ruleSwitches: state(), setRuleSwitch: action as never });
    await userEvent.click(within(panel).getByTestId("rule-switch-nine_identity_reply"));
    await userEvent.click(within(panel).getByTestId("rule-switch-nine_confirmed_owner_drip"));
    await waitFor(() => expect(within(panel).getByTestId("rule-switch-state-nine_confirmed_owner_drip")).toHaveTextContent("Off"));
    releaseIdentity({ ok: true, data: state({ nineIdentityReply: false, nineConfirmedOwnerDrip: true }) });
    await waitFor(() => expect(within(panel).getByTestId("rule-switch-state-nine_identity_reply")).toHaveTextContent("Off"));
    expect(within(panel).getByTestId("rule-switch-state-nine_confirmed_owner_drip")).toHaveTextContent("Off");
  });
});
