import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// PROPOSED (RED): Messages thread action. `QueueNormaAction({ propertyId, propertyAddress })` in ./queue-norma-action.tsx renders
// nothing when the thread has no resolved lead; otherwise a button that opens the same NormaQueueDialog as the leads page
// (shared server action queueNormaCalls). Wiring into <InboxDetail /> is pinned in inbox-detail.queue-norma.test.tsx.
const { queueNormaCalls } = vi.hoisted(() => ({ queueNormaCalls: vi.fn() }));
vi.mock("../leads/queue-norma-actions", () => ({ queueNormaCalls }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { QueueNormaAction } from "./queue-norma-action";

beforeEach(() => {
  vi.clearAllMocks();
  queueNormaCalls.mockResolvedValue({ ok: true, queueEnabled: true, results: [{ propertyId: "prop-1", result: "queued" }] });
});

describe("QueueNormaAction", () => {
  it.each([[null], [undefined], [""]])("renders nothing when the property is unresolved (%j)", (propertyId) => {
    const { container } = render(<QueueNormaAction propertyId={propertyId as string | null} propertyAddress={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a trigger when the thread resolves to a lead", () => {
    render(<QueueNormaAction propertyId="prop-1" propertyAddress="1 Main St" />);
    expect(screen.getByTestId("queue-norma-action")).toBeEnabled();
  });

  it("opens the shared dialog for exactly this lead and queues it through the shared action", async () => {
    const user = userEvent.setup();
    render(<QueueNormaAction propertyId="prop-1" propertyAddress="1 Main St" />);
    await user.click(screen.getByTestId("queue-norma-action"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByTestId("norma-queue-count")).toHaveTextContent("1");
    await user.type(screen.getByTestId("norma-queue-context"), "texted yes");
    await user.click(screen.getByTestId("norma-queue-submit"));
    await waitFor(() => expect(queueNormaCalls).toHaveBeenCalledWith(["prop-1"], "texted yes"));
  });

  it("sends nothing until the rep confirms in the dialog", async () => {
    const user = userEvent.setup();
    render(<QueueNormaAction propertyId="prop-1" propertyAddress="1 Main St" />);
    await user.click(screen.getByTestId("queue-norma-action"));
    expect(queueNormaCalls).not.toHaveBeenCalled();
  });
});
