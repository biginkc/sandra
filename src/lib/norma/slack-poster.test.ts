import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ postMessage: vi.fn() }));
vi.mock("@slack/web-api", () => ({ WebClient: class { chat = { postMessage: mocks.postMessage }; } }));
vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

import { createNormaSlackPoster } from "./slack-worker";

describe("createNormaSlackPoster", () => {
  beforeEach(() => mocks.postMessage.mockReset());

  it("posts to the configured channel with link and media unfurling off", async () => {
    mocks.postMessage.mockResolvedValue({ ok: true, ts: "1.1" });
    const post = createNormaSlackPoster({ botToken: "t", channelId: "C1" });
    await expect(post({ blocks: [], text: "hi" })).resolves.toEqual({ ts: "1.1" });
    expect(mocks.postMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: "C1", unfurl_links: false, unfurl_media: false }));
  });

  it("throws when Slack does not return a ts", async () => {
    mocks.postMessage.mockResolvedValue({ ok: false, error: "channel_not_found" });
    await expect(createNormaSlackPoster({ botToken: "t", channelId: "C1" })({ blocks: [], text: "x" })).rejects.toThrow("slack_post_failed:channel_not_found");
  });
});
