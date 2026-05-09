import { beforeEach, describe, expect, it, vi } from "vitest";

const { afterMock } = vi.hoisted(() => ({ afterMock: vi.fn() }));
const { verifySlackSignature } = vi.hoisted(() => ({
  verifySlackSignature: vi.fn(),
}));
const { completeTaskFromSlack, refreshSlackMessage } = vi.hoisted(() => ({
  completeTaskFromSlack: vi.fn(),
  refreshSlackMessage: vi.fn(),
}));

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>(
    "next/server",
  );
  return {
    ...actual,
    after: (fn: () => Promise<void>) => afterMock(fn),
  };
});

vi.mock("@/lib/integrations/slack/signature", () => ({
  verifySlackSignature,
}));

vi.mock("@/lib/integrations/slack/dispatch", () => ({
  completeTaskFromSlack,
  refreshSlackMessage,
}));

vi.mock("@/lib/errors/report", () => ({
  reportError: vi.fn(),
}));

import { POST } from "./route";

const taskId = "11111111-1111-4111-8111-111111111111";

function slackRequest(payload: unknown): Request {
  const body = new URLSearchParams({
    payload: JSON.stringify(payload),
  }).toString();
  return new Request("https://sandra.test/api/webhooks/slack/actions", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": "1710000000",
      "x-slack-signature": "v0=test",
    },
    body,
  });
}

function blockActionsPayload(overrides: Record<string, unknown> = {}) {
  return {
    type: "block_actions",
    team: { id: "T_TEST" },
    user: { id: "U_TEST", name: "Jarrad" },
    channel: { id: "D123" },
    message: { ts: "1710000000.000100" },
    actions: [{ action_id: "mark_done", value: taskId }],
    ...overrides,
  };
}

describe("webhooks/slack/actions route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("SLACK_SIGNING_SECRET", "secret");
    verifySlackSignature.mockReturnValue(true);
    completeTaskFromSlack.mockResolvedValue({ ok: true });
    refreshSlackMessage.mockResolvedValue({ ok: true });
  });

  it("rejects with 401 when signature is invalid", async () => {
    verifySlackSignature.mockReturnValueOnce(false);

    const response = await POST(slackRequest(blockActionsPayload()));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_signature",
    });
    expect(afterMock).not.toHaveBeenCalled();
  });

  it("returns 200 and ok:true when payload.type is not block_actions", async () => {
    const response = await POST(slackRequest({ type: "view_submission" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(afterMock).not.toHaveBeenCalled();
  });

  it("returns 200 when action_id is in the allowlist and schedules after", async () => {
    const response = await POST(slackRequest(blockActionsPayload()));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(afterMock).toHaveBeenCalledTimes(1);
  });

  it("does not schedule after when action_id is not in the allowlist", async () => {
    const response = await POST(
      slackRequest(
        blockActionsPayload({
          actions: [{ action_id: "unknown_action", value: taskId }],
        }),
      ),
    );

    expect(response.status).toBe(200);
    expect(afterMock).not.toHaveBeenCalled();
  });

  it("does not schedule after when action.value is not a UUID", async () => {
    const response = await POST(
      slackRequest(
        blockActionsPayload({
          actions: [{ action_id: "mark_done", value: "not-a-uuid" }],
        }),
      ),
    );

    expect(response.status).toBe(200);
    expect(afterMock).not.toHaveBeenCalled();
  });

  it("after callback invokes completeTaskFromSlack and refreshSlackMessage in order", async () => {
    await POST(slackRequest(blockActionsPayload()));

    const callback = afterMock.mock.calls[0]?.[0];
    expect(callback).toBeTypeOf("function");
    await callback();

    expect(completeTaskFromSlack).toHaveBeenCalledWith({
      taskId,
      slackUserId: "U_TEST",
      teamId: "T_TEST",
    });
    expect(refreshSlackMessage).toHaveBeenCalledWith({
      channel: "D123",
      messageTs: "1710000000.000100",
      taskId,
      doneByUserName: "Jarrad",
    });
    expect(completeTaskFromSlack.mock.invocationCallOrder[0]).toBeLessThan(
      refreshSlackMessage.mock.invocationCallOrder[0],
    );
  });
});
