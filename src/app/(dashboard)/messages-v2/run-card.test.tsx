import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RunCard } from "./run-card";
import type { PipelineRunStep, RunWithSteps } from "./types";

const step = (
  seq: number,
  over: Partial<PipelineRunStep>,
): PipelineRunStep => ({
  id: `s${seq}`,
  run_id: "r1",
  org_id: "o",
  seq,
  kind: "gate",
  name: "gate",
  result: "pass",
  detail: {},
  created_at: "2026-10-08T10:00:01Z",
  ...over,
});

const baseRun = (over: Partial<RunWithSteps> = {}): RunWithSteps => ({
  id: "r1",
  org_id: "o",
  inbound_message_id: "m1",
  property_id: "p1",
  contact_id: "c1",
  conversation_id: "conv-1",
  status: "replied",
  mode: "automatic",
  final_outcome: null,
  reason: null,
  classification_run_id: null,
  claim_id: null,
  outbound_message_id: null,
  inbound_preview: "not interested, please stop",
  started_at: "2026-10-08T10:00:00Z",
  completed_at: "2026-10-08T10:00:05Z",
  steps: [],
  ...over,
});

const label = { name: "Dana", address: "12 Elm St, Kansas City" };

describe("RunCard", () => {
  it("shows name, address and the inbound preview", () => {
    render(<RunCard run={baseRun()} label={label} />);
    expect(screen.getByText("Dana")).toBeInTheDocument();
    expect(screen.getByText(/12 Elm St, Kansas City/)).toBeInTheDocument();
    expect(screen.getByText("not interested, please stop")).toBeInTheDocument();
  });

  it("renders the Jev judgment with its top scores", () => {
    const run = baseRun({
      steps: [
        step(1, {
          kind: "jev",
          name: "classify",
          result: "pass",
          detail: {
            scores: { nurture: 0.91, not_interested: 0.06, new_lead: 0.01 },
          },
        }),
      ],
    });
    render(<RunCard run={run} label={label} />);
    const line = screen.getByTestId("step-jev");
    expect(within(line).getByText(/nurture 91%/)).toBeInTheDocument();
    expect(within(line).getByText(/not_interested 6%/)).toBeInTheDocument();
  });

  it("renders applied actions, a sent reply with persona, and blocked gates", () => {
    const run = baseRun({
      steps: [
        step(1, { kind: "gate", name: "quiet_hours", result: "block" }),
        step(2, {
          kind: "action",
          name: "set_stage:nurture",
          result: "applied",
        }),
        step(3, {
          kind: "reply",
          name: "reply",
          result: "sent",
          detail: { persona: "Mel" },
        }),
      ],
    });
    render(<RunCard run={run} label={label} />);
    expect(screen.getByTestId("step-gate")).toHaveTextContent("quiet_hours");
    expect(screen.getByTestId("step-action")).toHaveTextContent(
      "set_stage:nurture",
    );
    expect(screen.getByTestId("step-reply")).toHaveTextContent(/sent, as Mel/);
  });

  it("renders shadow steps muted as 'would →'", () => {
    const run = baseRun({
      steps: [
        step(1, {
          kind: "shadow",
          name: "set_stage:nurture",
          result: "would_apply",
        }),
      ],
    });
    render(<RunCard run={run} label={label} />);
    const line = screen.getByTestId("step-shadow");
    expect(line).toHaveTextContent(/would → set_stage:nurture/);
    expect(line.className).toMatch(/muted/);
  });

  it("pulses while the run is still running", () => {
    render(
      <RunCard
        run={baseRun({ status: "running", completed_at: null })}
        label={label}
      />,
    );
    expect(screen.getByTestId("run-pulse")).toBeInTheDocument();
  });

  it("does not pulse once complete", () => {
    render(<RunCard run={baseRun()} label={label} />);
    expect(screen.queryByTestId("run-pulse")).not.toBeInTheDocument();
  });

  it("links to the lead page in a new tab when the run has a property", () => {
    render(<RunCard run={baseRun()} label={label} />);
    const link = screen.getByRole("link", { name: /open thread/i });
    expect(link).toHaveAttribute("href", "/leads/p1");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("links to /messages only for owners when there is no property", () => {
    const run = baseRun({ property_id: null });
    const { unmount } = render(<RunCard run={run} label={label} isOwner />);
    expect(screen.getByRole("link", { name: /open thread/i })).toHaveAttribute(
      "href",
      "/messages?thread=conv-1",
    );
    unmount();
    render(<RunCard run={run} label={label} isOwner={false} />);
    expect(
      screen.queryByRole("link", { name: /open thread/i }),
    ).not.toBeInTheDocument();
  });

  it("omits the link when there is neither property nor conversation", () => {
    render(
      <RunCard
        run={baseRun({ property_id: null, conversation_id: null })}
        label={label}
        isOwner
      />,
    );
    expect(
      screen.queryByRole("link", { name: /open thread/i }),
    ).not.toBeInTheDocument();
  });

  it("falls back gracefully when no label has loaded", () => {
    render(<RunCard run={baseRun()} label={undefined} />);
    expect(screen.getByText("Unknown sender")).toBeInTheDocument();
  });
});

describe("RunCard undo", () => {
  const applied = (name: string) => [step(1, { kind: "action", name, result: "applied" })];

  it("offers Undo for a Jev-applied action and calls undo with the record id", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    const controls = {
      find: vi.fn(async () => "undo-1"),
      undo: vi.fn(async () => ({ ok: true as const })),
    };
    render(<RunCard run={baseRun({ steps: applied("wrong_number") })} label={label} undoControls={controls} />);
    const btn = await screen.findByTestId("undo-jev-action");
    await userEvent.click(btn);
    expect(controls.find).toHaveBeenCalledWith("m1");
    expect(controls.undo).toHaveBeenCalledWith("undo-1");
    expect(await screen.findByTestId("undo-done")).toBeInTheDocument();
  });

  it("shows the refusal when the lead changed since", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    const controls = {
      find: vi.fn(async () => "undo-1"),
      undo: vi.fn(async () => ({ ok: false as const, message: "Someone changed this lead after Jev did" })),
    };
    render(<RunCard run={baseRun({ steps: applied("apply_nurture") })} label={label} undoControls={controls} />);
    await userEvent.click(await screen.findByTestId("undo-jev-action"));
    expect(await screen.findByTestId("undo-error")).toHaveTextContent(/changed this lead/);
  });

  it("shows no Undo when nothing is recorded, for held actions, or without controls", async () => {
    const none = { find: vi.fn(async () => null), undo: vi.fn() };
    render(<RunCard run={baseRun({ steps: applied("wrong_number") })} label={label} undoControls={none} />);
    await vi.waitFor(() => expect(none.find).toHaveBeenCalled());
    expect(screen.queryByTestId("undo-jev-action")).toBeNull();

    const held = { find: vi.fn(async () => "undo-1"), undo: vi.fn() };
    render(<RunCard run={baseRun({ steps: [step(1, { kind: "action", name: "opted_out", result: "held" })] })} label={label} undoControls={held} />);
    expect(held.find).not.toHaveBeenCalled();
  });
});
