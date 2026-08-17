import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SmsEntryPointGate } from "./sms-channel-restriction";

function SmsEntryPoints({
  restricted,
  restrictionLabel = "Opted out",
  restrictionDetail = "SMS is disabled. Calls, notes, and tasks remain available. This is not a permanent DNC.",
}: {
  restricted: boolean;
  restrictionLabel?: string;
  restrictionDetail?: string;
}) {
  return (
    <>
      <SmsEntryPointGate
        restricted={restricted}
        placement="header"
        restrictionLabel={restrictionLabel}
        restrictionDetail={restrictionDetail}
      >
        <button>Send SMS</button>
      </SmsEntryPointGate>
      <SmsEntryPointGate
        restricted={restricted}
        placement="inline"
        restrictionLabel={restrictionLabel}
        restrictionDetail={restrictionDetail}
      >
        <label>
          Reply
          <textarea />
        </label>
      </SmsEntryPointGate>
    </>
  );
}

describe("SMS opt-out entry points", () => {
  it("replaces both SMS entry points with channel-only restriction copy", () => {
    render(<SmsEntryPoints restricted />);

    expect(screen.queryByRole("button", { name: "Send SMS" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Reply" })).toBeNull();
    expect(
      screen.getByTestId("sms-channel-restriction-header"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("sms-channel-restriction-inline"),
    ).toHaveTextContent("not a permanent DNC");
  });

  it("leaves both existing SMS surfaces intact when not opted out", () => {
    render(<SmsEntryPoints restricted={false} />);
    expect(
      screen.getByRole("button", { name: "Send SMS" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Reply" })).toBeInTheDocument();
  });

  it("uses the actual non-opt-out restriction reason", () => {
    render(
      <SmsEntryPoints
        restricted
        restrictionLabel="Landline only"
        restrictionDetail="SMS cannot be delivered to the selected landline. Call or mail instead."
      />,
    );

    expect(
      screen.getByTestId("sms-channel-restriction-header"),
    ).toHaveTextContent("Landline only");
    expect(
      screen.getByTestId("sms-channel-restriction-inline"),
    ).toHaveTextContent("selected landline");
    expect(screen.queryByText(/homeowner opted out/i)).toBeNull();
  });
});
