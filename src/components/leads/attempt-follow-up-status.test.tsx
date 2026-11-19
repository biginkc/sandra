import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AttemptFollowUpStatus } from "./attempt-follow-up-status";

describe("<AttemptFollowUpStatus />", () => {
  it.each([
    ["required", "Open Text lead to resume this saved follow-up."],
    ["draft", "Open Text lead to resume this saved follow-up."],
    ["failed_not_dispatched", "Open Text lead to resume this saved follow-up."],
    ["accepted", "Review the text history for the provider and delivery record."],
    ["delivered", "Review the text history for the provider and delivery record."],
    ["blocked", "Resolve the blocked reason, then review the saved follow-up before sending."],
    ["unknown", "Review the text history before retrying; automatic retry is disabled."],
    ["delivery_failed", "Review the text history before retrying; automatic retry is disabled."],
  ] as const)("shows guidance for %s", (status, guidance) => {
    render(<AttemptFollowUpStatus attemptId="a1" status={status} />);
    expect(screen.getByTestId("attempt-follow-up-a1")).toBeInTheDocument();
    expect(screen.getByText(guidance)).toBeInTheDocument();
  });

  it("formats the status and shows message and blocked reason", () => {
    render(
      <AttemptFollowUpStatus
        attemptId="a2"
        status="failed_not_dispatched"
        message="Template missing"
        blockedReason="No consent"
      />,
    );
    expect(screen.getByText("Text follow-up: Failed not dispatched")).toBeInTheDocument();
    expect(screen.getByText("Status detail: Template missing")).toBeInTheDocument();
    expect(screen.getByText("Blocked reason: No consent")).toBeInTheDocument();
  });
});
