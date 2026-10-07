import { beforeEach, describe, expect, it, vi } from "vitest";

const { postMessage, open, loadPrefs, getToken, repSms } = vi.hoisted(() => ({
  postMessage: vi.fn(),
  open: vi.fn(),
  loadPrefs: vi.fn(),
  getToken: vi.fn(),
  repSms: vi.fn(),
}));
vi.mock("@slack/web-api", () => ({
  WebClient: vi.fn(function () {
    return { conversations: { open }, chat: { postMessage } };
  }),
}));
vi.mock("@/lib/integrations/prefs", () => ({ loadIntegrationPrefs: loadPrefs }));
vi.mock("@/lib/integrations/tokens/store", () => ({ getDecryptedToken: getToken }));
vi.mock("@/lib/notifications/rep-sms", () => ({ sendRepSmsReminder: repSms }));
vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

import { createChannelSenders } from "./channels";

const admin = {
  auth: { admin: { getUserById: vi.fn(async () => ({ data: { user: { email: "o@example.com" } }, error: null })) } },
} as never;

describe("sendSlack", () => {
  beforeEach(() => {
    postMessage.mockReset().mockResolvedValue({ ts: "1.2" });
    open.mockReset().mockResolvedValue({ channel: { id: "D1" } });
    loadPrefs.mockReset().mockResolvedValue({ slackEnabled: true, reminderPhone: null });
    getToken.mockReset().mockResolvedValue({ externalAccountId: "U1", accessToken: { reveal: () => "xoxb" } });
  });

  it("sends the DM through the per-user token", async () => {
    const r = await createChannelSenders(admin).sendSlack("u1", "hello");
    expect(r).toEqual({ status: "sent" });
    expect(open).toHaveBeenCalledWith({ users: "U1" });
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: "D1", text: "hello" }));
  });
  it("reports pref_disabled and no_token as skipped", async () => {
    loadPrefs.mockResolvedValue({ slackEnabled: false, reminderPhone: null });
    expect(await createChannelSenders(admin).sendSlack("u1", "x")).toEqual({ status: "skipped", reason: "pref_disabled" });
    loadPrefs.mockResolvedValue({ slackEnabled: true, reminderPhone: null });
    getToken.mockResolvedValue(null);
    expect(await createChannelSenders(admin).sendSlack("u1", "x")).toEqual({ status: "skipped", reason: "no_token" });
  });
  it("a pre-send error is a retryable failure", async () => {
    open.mockRejectedValue(new Error("rate_limited"));
    const r = await createChannelSenders(admin).sendSlack("u1", "x");
    expect(r).toMatchObject({ status: "failed", error: "rate_limited" });
    expect((r as { terminal?: boolean }).terminal).toBeFalsy();
  });
  it("an error during chat.postMessage is terminal (may have been delivered)", async () => {
    postMessage.mockRejectedValue(new Error("timeout"));
    expect(await createChannelSenders(admin).sendSlack("u1", "x")).toMatchObject({ status: "failed", terminal: true });
  });
});

describe("sendSms", () => {
  beforeEach(() => {
    repSms.mockReset().mockResolvedValue({ ok: true, externalId: "e1" });
    loadPrefs.mockReset().mockResolvedValue({ slackEnabled: true, reminderPhone: "+18165550100" });
  });
  it("sends to the owner's phone on file", async () => {
    expect(await createChannelSenders(admin).sendSms("u1", "hot")).toEqual({ status: "sent" });
    expect(repSms).toHaveBeenCalledWith(expect.objectContaining({ to: "+18165550100", body: "hot" }));
  });
  it("skips with no_phone when none is on file", async () => {
    loadPrefs.mockResolvedValue({ slackEnabled: true, reminderPhone: null });
    expect(await createChannelSenders(admin).sendSms("u1", "x")).toEqual({ status: "skipped", reason: "no_phone" });
    expect(repSms).not.toHaveBeenCalled();
  });
  it("maps not_configured to skipped and ambiguous results to terminal failures", async () => {
    repSms.mockResolvedValue({ ok: false, reason: "not_configured", message: "m" });
    expect(await createChannelSenders(admin).sendSms("u1", "x")).toEqual({ status: "skipped", reason: "not_configured" });
    repSms.mockResolvedValue({ ok: false, reason: "aborted_ambiguous", message: "m" });
    expect(await createChannelSenders(admin).sendSms("u1", "x")).toMatchObject({ status: "failed", terminal: true });
    repSms.mockResolvedValue({ ok: false, reason: "provider_error", message: "m" });
    const r = await createChannelSenders(admin).sendSms("u1", "x");
    expect(r).toMatchObject({ status: "failed" });
    expect((r as { terminal?: boolean }).terminal).toBeFalsy();
  });
});

describe("sendEmail", () => {
  const message = { subject: "Holds", text: "body" };
  it("skips with no_resend_key when the key is absent, without calling fetch", async () => {
    const fetchImpl = vi.fn();
    const s = createChannelSenders(admin, { env: { HOLD_ALERT_EMAIL_FROM: "a@b.c" }, fetch: fetchImpl as never });
    expect(await s.sendEmail("u1", message)).toEqual({ status: "skipped", reason: "no_resend_key" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("skips with no_email_from when no sender is configured", async () => {
    const fetchImpl = vi.fn();
    const s = createChannelSenders(admin, { env: { RESEND_API_KEY: "k" }, fetch: fetchImpl as never });
    expect(await s.sendEmail("u1", message)).toEqual({ status: "skipped", reason: "no_email_from" });
  });
  it("posts to Resend with the bearer key", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const s = createChannelSenders(admin, {
      env: { RESEND_API_KEY: "k", HOLD_ALERT_EMAIL_FROM: "Sandra <a@b.c>" },
      fetch: fetchImpl as never,
    });
    expect(await s.sendEmail("u1", message)).toEqual({ status: "sent" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k");
    expect(JSON.parse(init.body as string)).toMatchObject({
      from: "Sandra <a@b.c>",
      to: ["o@example.com"],
      subject: "Holds",
      text: "body",
    });
  });
  it("a non-2xx response is a retryable failure", async () => {
    const s = createChannelSenders(admin, {
      env: { RESEND_API_KEY: "k", HOLD_ALERT_EMAIL_FROM: "a@b.c" },
      fetch: (async () => new Response("no", { status: 500 })) as never,
    });
    expect(await s.sendEmail("u1", message)).toMatchObject({ status: "failed" });
  });
});
