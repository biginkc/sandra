import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { NINE_ANSWER_LABELS, NINE_QUESTION_IDS, type NineAnswer } from "@/lib/sms-classification/nine-questions";

import { RulesPanel } from "./rules-panel";
import { deriveTape, reasonWord, tapeTagForRun, tapeTagForWord } from "./tape";
import type { PipelineRunStep, RunWithSteps } from "./types";

vi.mock("./label-rule-editor", () => ({ isEditableBadge: () => false, LabelRuleEditor: () => null }));
vi.mock("./nurture-auto-drip-switch", () => ({ NurtureAutoDripSwitch: () => null }));
vi.mock("./reply-generation-toggle", () => ({ ReplyGenerationToggle: () => null }));

const step = (detail: Record<string, unknown>): PipelineRunStep => ({
  id: "s", run_id: "r", org_id: "o", seq: 1, kind: "jev", name: "classify", result: "ok" as PipelineRunStep["result"], detail, created_at: "",
});
const run = (steps: PipelineRunStep[], over: Partial<RunWithSteps> = {}): RunWithSteps => ({
  id: "r", org_id: "o", inbound_message_id: "m", property_id: null, contact_id: null, conversation_id: null,
  status: "closed", mode: "automatic", final_outcome: null, reason: null, classification_run_id: null, claim_id: null,
  outbound_message_id: null, inbound_preview: "x", started_at: "2026-10-14T12:00:00Z", completed_at: null, steps, ...over,
});

describe("nine-question tape tag", () => {
  const answers: NineAnswer[] = [...NINE_QUESTION_IDS, "needs_person"];
  it.each(answers)("%s shows its label", (answer) => {
    const r = run([step({ engine: "nine_questions", answer, probabilities: { [answer]: 0.9 } })]);
    expect(tapeTagForRun(r)?.label).toBe(NINE_ANSWER_LABELS[answer]);
    const view = deriveTape(r, "Sam");
    expect(view.kind).toBe("decided");
  });

  it("covers all ten answers", () => expect(answers).toHaveLength(10));

  it("old-engine runs keep today's mapping", () => {
    expect(tapeTagForRun(run([step({ outcome: "nurture" })]))?.label).toBe("Maybe later");
  });

  it("a shadow run (shadow_engine) reads as old-engine", () => {
    expect(tapeTagForRun(run([step({ shadow_engine: "nine_questions", answer: "hostile", outcome: "nurture" })]))?.label).toBe("Maybe later");
  });

  it.each([
    ["nine_asked_stop", "Asked to stop"],
    ["nine_needs_person", "Can't read it"],
    ["nine_automation_disabled:wrong_number", "Wrong person"],
    ["nine_reply_not_sent:automation_disabled", "Waits for a person"],
    ["reply_text_not_approved", "Waits for a person"],
    ["drip_switch_off", "Waits for a person"],
  ])("hold reason %s -> %s", (reason, label) => {
    expect(tapeTagForWord(reasonWord(reason))?.label).toBe(label);
  });

  it("ignores a malformed nine payload and falls back", () => {
    expect(tapeTagForRun(run([step({ engine: "nine_questions", answer: "bogus", outcome: "nurture" })]))?.label).toBe("Maybe later");
    expect(tapeTagForRun(run([step({ engine: "nine_questions" })]))).toBeNull();
  });
});

const base = { orgId: "o", isOwner: true, badges: [{ label: "nurture", mode: "AUTO", minConfidence: 0.9 }] as never };
const open = async (props: Partial<Parameters<typeof RulesPanel>[0]> = {}) => {
  const { default: userEvent } = await import("@testing-library/user-event");
  render(<RulesPanel {...base} {...props} />);
  await userEvent.click(screen.getByTestId("open-rules"));
  return screen.getByTestId("rules-panel");
};

describe("rules panel", () => {
  it("nine_questions: nine rows in three groups plus the cutoff row", async () => {
    const panel = await open({ classifierEngine: "nine_questions" });
    expect(within(panel).getAllByTestId("rule-row")).toHaveLength(10);
    const group = (name: string) => within(within(panel).getByRole("region", { name })).getAllByTestId("rule-row").map((r) => within(r).getAllByText(/./)[0].textContent);
    expect(group("Goes to Jarrad")).toEqual(["Wants an offer", "Talked price"]);
    expect(group("Sandra handles alone")).toEqual(["Maybe later", "Asked who is texting", "Not interested", "Wrong person", "Confirmed owner"]);
    expect(group("Waits for a person")).toEqual(["Asked to stop", "Hostile"]);
    expect(within(panel).getByText("60% sure or more")).toBeTruthy();
    expect(panel.textContent).not.toMatch(/Jev/);
    expect(within(panel).getByText("On")).toBeTruthy();
    expect(panel.textContent).not.toMatch(/90%/);
    expect(within(panel).getAllByText(/sure or more/)).toHaveLength(1);
  });

  it("old engine: today's panel unchanged", async () => {
    const panel = await open({ classifierEngine: null });
    expect(within(panel).queryByTestId("nine-rules")).toBeNull();
    expect(within(panel).getByText("Open to selling or wants an offer")).toBeTruthy();
    expect(panel.textContent).not.toMatch(/Jev/);
  });
});
