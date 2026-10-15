import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const composer = vi.hoisted(() => ({ props: null as null | Record<string, unknown>, showTextarea: false }));
vi.mock("../rep-sms-composer", () => ({
  RepSmsComposer: (props: Record<string, unknown>) => {
    composer.props = props;
    return (
      <>
        <button type="button" onClick={() => (props.onSent as (id?: string) => void)("msg-9")}>Text lead</button>
        {composer.showTextarea && <textarea aria-label="Editable message remainder" />}
      </>
    );
  },
}));

import { AllTexts } from "./all-texts";

const detailState = {
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

const withInbound = (id: string, createdAt: string) => ({
  ...detailState,
  detail: { ...detailState.detail, messages: { rows: [{ id, body: "hi", direction: "inbound" as const, createdAt, createdLabel: "", deliveryStatus: "received", attachmentCount: 0 }], hasMore: false, nextCursor: null } },
});

beforeEach(() => { composer.props = null; composer.showTextarea = false; });

describe("<AllTexts />", () => {
  it("shows the text history strip and the action-placement composer with the reply-to stamp", () => {
    render(
      <AllTexts
        facts={{ propertyId: "lead-1", latestInbound: { at: "2026-10-14T14:00:00Z", kind: "text", messageId: "inb-7", handled: false, contactOnly: false } }}
        state={withInbound("inb-7", "2026-10-14T14:00:00Z")}
        onRetry={() => {}}
      />,
    );
    expect(screen.getByRole("region", { name: "Text history" })).toBeInTheDocument();
    expect(composer.props).toMatchObject({ propertyId: "lead-1", placement: "action", inboundMessageId: "inb-7" });
  });
  it("stamps the newest inbound DISPLAYED, and a newer classifier reply blocks the composer until the thread refreshes", () => {
    const onRetry = vi.fn();
    render(
      <AllTexts
        facts={{ propertyId: "lead-1", latestInbound: { at: "2026-10-14T15:00:00Z", kind: "text", messageId: "inb-Y", handled: false, contactOnly: false } }}
        state={withInbound("inb-X", "2026-10-14T14:00:00Z")}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByTestId("all-texts-stale-lead-1")).toHaveTextContent("New reply arrived");
    expect(screen.queryByRole("button", { name: "Text lead" })).not.toBeInTheDocument();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
  it("passes a null stamp when there is no inbound", () => {
    render(<AllTexts facts={{ propertyId: "lead-1", latestInbound: null }} state={detailState} onRetry={() => {}} />);
    expect(composer.props?.inboundMessageId).toBeNull();
  });
  it("a missed-call inbound carries no message id, so no stamp", () => {
    render(<AllTexts facts={{ propertyId: "lead-1", latestInbound: { at: "2026-10-14T14:00:00Z", kind: "call", messageId: null, handled: false, contactOnly: false } }} state={detailState} onRetry={() => {}} />);
    expect(composer.props?.inboundMessageId).toBeNull();
  });
  it("a send reloads the thread and tells the container", async () => {
    const onRetry = vi.fn();
    const onSent = vi.fn();
    render(<AllTexts facts={{ propertyId: "lead-1", latestInbound: null }} state={detailState} onRetry={onRetry} onSent={onSent} />);
    await userEvent.click(screen.getByRole("button", { name: "Text lead" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onSent).toHaveBeenCalledExactlyOnceWith("msg-9");
  });
  it("focuses the composer textarea when it is already there", () => {
    composer.showTextarea = true;
    render(<AllTexts facts={{ propertyId: "lead-1", latestInbound: null }} state={detailState} onRetry={() => {}} />);
    expect(screen.getByRole("textbox", { name: "Editable message remainder" })).toHaveFocus();
  });
  it("focuses the textarea the first time it appears, without opening the composer", async () => {
    const view = render(<AllTexts facts={{ propertyId: "lead-1", latestInbound: null }} state={detailState} onRetry={() => {}} />);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    composer.showTextarea = true;
    view.rerender(<AllTexts facts={{ propertyId: "lead-1", latestInbound: null }} state={detailState} onRetry={() => {}} />);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Editable message remainder" })).toHaveFocus());
  });
  it("does not pull focus out of another field the rep is typing in", () => {
    const outside = document.createElement("input");
    document.body.appendChild(outside);
    outside.focus();
    composer.showTextarea = true;
    render(<AllTexts facts={{ propertyId: "lead-1", latestInbound: null }} state={detailState} onRetry={() => {}} />);
    expect(outside).toHaveFocus();
    outside.remove();
  });
  it("shows the strip's loading state while detail loads", () => {
    render(<AllTexts facts={{ propertyId: "lead-1", latestInbound: null }} state={{ status: "loading" }} onRetry={() => {}} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading texts");
  });
});
