import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("../sms-actions", () => ({ loadRepSmsContext: mocks.load, sendRepSms: vi.fn(), acknowledgeRepSmsSubmission: vi.fn() }));

import { AllTexts } from "./all-texts";

const state = {
  status: "ready" as const,
  detail: {
    messages: { rows: [], hasMore: false, nextCursor: null },
    notes: { rows: [], hasMore: false, nextCursor: null },
    attempts: { rows: [], hasMore: false, nextCursor: null },
    appointments: { rows: [], hasMore: false, nextCursor: null },
    offers: { rows: [], hasMore: false, nextCursor: null },
    history: { rows: [], hasMore: false, nextCursor: null },
  },
};

beforeEach(() => {
  mocks.load.mockReset();
  mocks.load.mockResolvedValue({
    ok: true,
    data: {
      orgId: "o", actorId: "a", contactId: "c", phone: "+18165550123", provider: "sendillo", obligation: null,
      senders: [{ id: "s1", number: "+18163706846", label: "Mel", isDefault: true, provider: "sendillo", providerSenderId: "p", grantStatus: "active", compositionPolicyVersion: 1 }],
    },
  });
});

describe("<AllTexts /> with the real composer", () => {
  it("Reply (defaultOpen) yields an open composer with a focused textarea", async () => {
    render(<AllTexts facts={{ propertyId: "lead-1", latestInbound: null }} state={state} onRetry={() => {}} defaultOpen />);
    const textarea = await screen.findByLabelText("Editable message remainder");
    expect(textarea).toHaveFocus();
  });
  it("without defaultOpen the composer stays closed and nothing is focused", () => {
    render(<AllTexts facts={{ propertyId: "lead-1", latestInbound: null }} state={state} onRetry={() => {}} />);
    expect(screen.queryByLabelText("Editable message remainder")).not.toBeInTheDocument();
  });
  it("canCompose=false renders history only", () => {
    render(<AllTexts facts={{ propertyId: "lead-1", latestInbound: null }} state={state} onRetry={() => {}} canCompose={false} />);
    expect(screen.queryByTestId("rep-sms-composer")).not.toBeInTheDocument();
  });
});
