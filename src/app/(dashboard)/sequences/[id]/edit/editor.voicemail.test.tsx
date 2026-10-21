import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SequenceEditor, type VoicemailDropEditorConfig } from "./editor";
import type { SequenceWithSteps } from "../../actions";

const replace = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));
vi.mock("../../actions", () => ({ replaceSequenceSteps: (...args: unknown[]) => replace(...args) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));

afterEach(() => { replace.mockReset(); });

const on: VoicemailDropEditorConfig = { enabled: true, defaultVoiceId: "voice-norma", defaultPhoneLineId: "line-1" };
const smsStep: SequenceWithSteps["steps"][number] = { id: "step-1", step_index: 0, delay_after_previous_minutes: 0,
  action_type: "send_sms", template_body: "Hi", template_id: null, template_category: null, target_status: null };
const dropStep: SequenceWithSteps["steps"][number] = { id: "step-2", step_index: 1, delay_after_previous_minutes: 1440,
  action_type: "send_voicemail_drop", template_body: null, template_id: null, template_category: null, target_status: null,
  vm_media_id: null, vm_tts_body: "Hi {{first_name}}", vm_voice_id: "voice-x", vm_phone_line_id: "line-x" };
const mount = (steps: SequenceWithSteps["steps"], voicemailDrop?: VoicemailDropEditorConfig) => render(
  <SequenceEditor sequence={{ id: "seq-1", name: "Drip", description: null, active: true, append_opt_out: true, archived_at: null, steps }}
    initialImpact={{ total_enrolled: 0, scheduled_next_7d: 0 }} templates={[]} voicemailDrop={voicemailDrop} />);
const card = (n: number) => screen.getByRole("heading", { name: `Step ${n}` }).closest("div.rounded-md.border") as HTMLElement;
const actionSelect = (n: number) => within(card(n)).getByRole("combobox", { name: "Action" });

describe("drip editor voicemail drop step", () => {
  it("is disabled with a note when no provider is set up", () => {
    mount([smsStep]);
    const option = within(actionSelect(1)).getByRole("option", { name: "Voicemail drop (not set up)" }) as HTMLOptionElement;
    expect(option.disabled).toBe(true);
    expect(screen.getByText(/Voicemail drops are off/)).toBeInTheDocument();
  });

  it("creates a script drop with defaults, merge fields, and saves it through the action", async () => {
    replace.mockResolvedValue({ ok: true, data: ["step-1", "step-new"] });
    const user = userEvent.setup(); mount([smsStep], on);
    await user.click(screen.getByRole("button", { name: "Add step" }));
    await user.selectOptions(actionSelect(2), "send_voicemail_drop");
    const save = screen.getByRole("button", { name: "Save all steps" });
    expect(save).toBeDisabled();
    expect(within(card(2)).getByLabelText("Voice")).toHaveValue("voice-norma");
    expect(within(card(2)).getByLabelText("Caller line")).toHaveValue("line-1");
    await user.type(within(card(2)).getByLabelText("Voicemail script"), "Hi");
    await user.click(within(card(2)).getByRole("button", { name: "Insert first name" }));
    await user.click(within(card(2)).getByRole("button", { name: "Insert property address" }));
    expect(within(card(2)).getByLabelText("Voicemail script")).toHaveValue("Hi {{first_name}} {{property_address}}");
    expect(within(card(2)).getByText("38 / 1,200")).toBeInTheDocument();
    await user.click(save);
    expect(replace).toHaveBeenCalledTimes(1);
    const steps = replace.mock.calls[0][0].steps;
    expect(steps[0]).toMatchObject({ action_type: "send_sms", vm_media_id: null, vm_tts_body: null, vm_voice_id: null, vm_phone_line_id: null });
    expect(steps[1]).toMatchObject({ action_type: "send_voicemail_drop", template_body: null, template_id: null,
      template_category: null, target_status: null, vm_media_id: null,
      vm_tts_body: "Hi {{first_name}} {{property_address}}", vm_voice_id: "voice-norma", vm_phone_line_id: "line-1" });
  });

  it("edits an existing drop to a recorded message and sends only the media id", async () => {
    replace.mockResolvedValue({ ok: true, data: ["step-1", "step-2"] });
    const user = userEvent.setup(); mount([smsStep, dropStep], on);
    expect(within(card(2)).getByLabelText("Voicemail script")).toHaveValue("Hi {{first_name}}");
    await user.click(within(card(2)).getByRole("radio", { name: "Recorded message" }));
    expect(screen.getByRole("button", { name: "Save all steps" })).toBeDisabled();
    await user.type(within(card(2)).getByLabelText("Recording ID"), "media-42");
    await user.click(screen.getByRole("button", { name: "Save all steps" }));
    expect(replace.mock.calls[0][0].steps[1]).toMatchObject({ id: "step-2", vm_media_id: "media-42", vm_tts_body: null,
      vm_voice_id: "voice-x", vm_phone_line_id: "line-x" });
  });

  it("blocks saving a script over 1,200 characters", async () => {
    mount([smsStep, { ...dropStep, vm_tts_body: "a".repeat(1201) }], on);
    expect(screen.getByText("1201 / 1,200")).toBeInTheDocument();
    expect(screen.getByText(/at most 1,200 characters/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save all steps" })).toBeDisabled();
  });

  it("blocks single-brace merge fields with a hint", () => {
    mount([smsStep, { ...dropStep, vm_tts_body: "Hi {first_name}" }], on);
    expect(screen.getByText(/Use double braces/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save all steps" })).toBeDisabled();
  });

  it("still shows an existing drop step when the provider is off", () => {
    mount([smsStep, dropStep]);
    expect(within(card(2)).getByText(/this step will not send/)).toBeInTheDocument();
    expect(actionSelect(2)).toHaveValue("send_voicemail_drop");
  });

  it("script mode with no voice and no default shows the error and blocks saving", () => {
    mount([smsStep, { ...dropStep, vm_voice_id: null }], { ...on, defaultVoiceId: null });
    expect(within(card(2)).getByText(/needs a voice/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save all steps" })).toBeDisabled();
  });

  it("a blank step voice is fine when a default voice exists", () => {
    mount([smsStep, { ...dropStep, vm_voice_id: null }], on);
    expect(within(card(2)).queryByText(/needs a voice/)).toBeNull();
    expect(screen.getByRole("button", { name: "Save all steps" })).toBeEnabled();
  });
});

describe("drip editor voicemail drop step — rotating saved scripts", () => {
  const withGroups: VoicemailDropEditorConfig = {
    ...on,
    scriptGroups: [
      { category: "Group A", count: 3, problemCount: 0 },
      { category: "Group B", count: 1, problemCount: 1 },
    ],
  };

  it("switches a script step to rotate a group and saves only the group", async () => {
    replace.mockResolvedValue({ ok: true, data: ["step-1", "step-2"] });
    const user = userEvent.setup(); mount([smsStep, dropStep], withGroups);
    await user.click(within(card(2)).getByRole("radio", { name: "Rotate between saved voicemail scripts" }));
    const save = screen.getByRole("button", { name: "Save all steps" });
    expect(save).toBeDisabled();
    const group = within(card(2)).getByLabelText("Script group");
    expect(within(group).getByRole("option", { name: "Group A (3 scripts)" })).toBeInTheDocument();
    await user.selectOptions(group, "Group A");
    await user.click(save);
    expect(replace.mock.calls[0][0].steps[1]).toMatchObject({ id: "step-2", vm_template_category: "Group A",
      vm_media_id: null, vm_tts_body: null, template_category: null, template_id: null, template_body: null,
      vm_voice_id: "voice-x" });
    expect(replace.mock.calls[0][0].steps[0]).toMatchObject({ vm_template_category: null });
  });

  it("warns when a chosen group has scripts the worker would refuse", () => {
    mount([smsStep, { ...dropStep, vm_tts_body: null, vm_template_category: "Group B" }], withGroups);
    expect(screen.getByText(/1 script in this group needs fixing/)).toBeInTheDocument();
  });

  it("points to the Templates page when there are no saved voicemail scripts", async () => {
    const user = userEvent.setup(); mount([smsStep, dropStep], on);
    await user.click(within(card(2)).getByRole("radio", { name: "Rotate between saved voicemail scripts" }));
    expect(screen.getByText(/No saved voicemail scripts yet/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save all steps" })).toBeDisabled();
  });

  it("blocks [a/b] random-variant brackets in a single script", () => {
    mount([smsStep, { ...dropStep, vm_tts_body: "[Hi/Hello] {{first_name}}" }], on);
    expect(screen.getByText(/Remove \[this\/that\] choices/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save all steps" })).toBeDisabled();
  });
});
