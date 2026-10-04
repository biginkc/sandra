import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadJob: vi.fn(),
  loadReceipt: vi.fn(),
  loadUrls: vi.fn(),
  fixture: vi.fn(),
  loadPreview: vi.fn(),
  claimCanary: vi.fn(),
  process: vi.fn(),
  finish: vi.fn(),
  sweep: vi.fn(),
  claim: vi.fn(),
  cleanup: vi.fn(),
}));

vi.mock("@/lib/integrations/slack/unfurl-store", () => ({
  claimSlackCanaryExecution: mocks.claimCanary,
  loadSlackUnfurlJob: mocks.loadJob,
  loadSlackUnfurlReceiptIdentity: mocks.loadReceipt,
  finishSlackUnfurlJob: mocks.finish,
  loadSlackJobUrls: mocks.loadUrls,
  claimSlackUnfurlJobs: mocks.claim,
  cleanupSlackUnfurlData: mocks.cleanup,
}));
vi.mock("@/lib/integrations/slack/unfurl-canary", () => ({
  freezeSlackCanaryPreview: (snapshot: unknown) => snapshot,
  loadSlackCanaryPreview: mocks.loadPreview,
  verifySlackCanaryFixture: mocks.fixture,
}));
vi.mock("@/lib/integrations/slack/unfurl-worker", () => ({ processSlackUnfurlJob: mocks.process, runSlackUnfurlSweep: mocks.sweep }));

import { POST } from "./route";

const RUN_ID = "00000000-0000-0000-0000-000000000001";
const JOB_ID = "00000000-0000-0000-0000-000000000002";
const CLAIM_TOKEN = "00000000-0000-0000-0000-000000000003";
const PROPERTY_ID = "00000000-0000-0000-0000-000000000004";
const INSTALLATION_ID = "00000000-0000-0000-0000-000000000005";
const ORG_ID = "00000000-0000-0000-0000-000000000bbb";
const CANONICAL_URL = `https://sandra.bmhgroupkc.com/my-leads?lead=${PROPERTY_ID}`;

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: "exact_job",
    runId: RUN_ID,
    jobId: JOB_ID,
    claimToken: CLAIM_TOKEN,
    propertyId: PROPERTY_ID,
    canonicalURL: CANONICAL_URL,
    installationId: INSTALLATION_ID,
    orgId: ORG_ID,
    channelId: "C123",
    messageTs: "171.1",
    posterId: "U123",
    ...overrides,
  };
}

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://sandra.example.test/api/cron/slack-unfurl-canary", {
    method: "POST",
    headers: { authorization: "Bearer cron-secret", "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function streamRequest(stream: ReadableStream<Uint8Array>, headers: Record<string, string> = {}): Request {
  return new Request("https://sandra.example.test/api/cron/slack-unfurl-canary", {
    method: "POST",
    headers: { authorization: "Bearer cron-secret", "content-type": "application/json", ...headers },
    body: stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

function baseJob(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id: JOB_ID,
    receipt_id: "00000000-0000-0000-0000-000000000006",
    installation_id: INSTALLATION_ID,
    installation_version: 1,
    policy_revision: null,
    org_id: ORG_ID,
    team_id: "T123",
    app_id: "A123",
    channel_id: "C123",
    message_ts: "171.1",
    poster_slack_user_id: "U123",
    event_time: new Date(now).toISOString(),
    status: "processing",
    attempts: 1,
    max_attempts: 5,
    next_attempt_at: new Date(now).toISOString(),
    lease_expires_at: new Date(now + 60_000).toISOString(),
    claim_token: CLAIM_TOKEN,
    last_error_code: null,
    expires_at: new Date(now + 15 * 60_000).toISOString(),
    created_at: new Date(now).toISOString(),
    updated_at: new Date(now).toISOString(),
    ...overrides,
  };
}

function baseSnapshot() {
  return {
    propertyId: PROPERTY_ID,
    leadName: "Synthetic Canary",
    address: "Canary Lane, MO",
    ownerName: "Synthetic Owner",
    ownerAssigned: true,
    latestAttempt: { id: "00000000-0000-0000-0000-000000000007", occurredAt: "2026-10-04T12:00:00.000Z", outcome: "reached" },
    messagesDisposition: "not_interested",
    lastContactAt: "2026-10-04T12:00:00.000Z",
    timezone: "America/Chicago",
    messages: [],
  };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CRON_SECRET", "cron-secret");
  mocks.loadJob.mockResolvedValue(baseJob());
  mocks.loadReceipt.mockResolvedValue({ id: "00000000-0000-0000-0000-000000000006", eventId: "Ev0C6PC6CR9S" });
  mocks.loadUrls.mockResolvedValue([{ url_key: CANONICAL_URL, lead_id: null, lookup_status: null, authorization_status: null, last_error_code: null }]);
  mocks.fixture.mockResolvedValue(true);
  mocks.loadPreview.mockResolvedValue(baseSnapshot());
  mocks.claimCanary.mockResolvedValue(true);
  mocks.process.mockResolvedValue("succeeded");
  mocks.finish.mockResolvedValue(true);
});

describe("hosted exact-job Slack canary route", () => {
  it("fails closed when CRON_SECRET is missing or authorization is wrong", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await POST(request(payload()))).status).toBe(500);
    vi.stubEnv("CRON_SECRET", "cron-secret");
    expect((await POST(request(payload(), { authorization: "Bearer wrong" }))).status).toBe(401);
    expect(mocks.loadJob).not.toHaveBeenCalled();
  });

  it("rejects non-JSON, malformed, oversized, unknown-field, and wrong-mode bodies", async () => {
    expect((await POST(request(payload(), { "content-type": "text/plain" }))).status).toBe(409);
    expect((await POST(request("{"))).status).toBe(409);
    expect((await POST(request(payload({ extra: true })))).status).toBe(409);
    expect((await POST(request(payload({ mode: "sweep" })))).status).toBe(409);
    expect((await POST(request("x".repeat(8_193), { "content-length": "8193" }))).status).toBe(409);
    expect(mocks.loadJob).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong persisted job", { id: "00000000-0000-0000-0000-000000000099" }, {}],
    ["wrong org", {}, { orgId: "00000000-0000-0000-0000-0000000000aa" }],
    ["wrong claim", {}, { claimToken: "00000000-0000-0000-0000-000000000099" }],
    ["wrong URL", {}, { canonicalURL: `https://sandra.bmhgroupkc.com/leads/${PROPERTY_ID}` }],
    ["queued job", { status: "queued" }, {}],
    ["expired lease", { lease_expires_at: new Date(Date.now() - 1_000).toISOString() }, {}],
    ["unbounded lease", { lease_expires_at: new Date(Date.now() + 121_000).toISOString() }, {}],
    ["second attempt", { attempts: 2 }, {}],
    ["missing receipt", {}, {}],
  ])("refuses %s before the worker", async (_label, jobOverrides, payloadOverrides) => {
    mocks.loadJob.mockResolvedValue(baseJob(jobOverrides));
    if (_label === "missing receipt") mocks.loadReceipt.mockResolvedValue(null);
    const response = await POST(request(payload(payloadOverrides)));
    expect(response.status).toBe(409);
    expect(mocks.process).not.toHaveBeenCalled();
    expect(mocks.sweep).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.cleanup).not.toHaveBeenCalled();
  });

  it.each([
    ["expired lease", { lease_expires_at: new Date(Date.now() - 1_000).toISOString() }],
    ["unbounded lease", { lease_expires_at: new Date(Date.now() + 121_000).toISOString() }],
  ])("terminally fences a trusted processing job with a %s", async (_label, jobOverrides) => {
    mocks.loadJob.mockResolvedValue(baseJob(jobOverrides));
    const response = await POST(request(payload()));
    expect(response.status).toBe(409);
    expect(mocks.process).not.toHaveBeenCalled();
    expect(mocks.finish).toHaveBeenCalledWith({
      jobId: JOB_ID,
      claimToken: CLAIM_TOKEN,
      status: "noop",
      errorCode: "canary_preflight_failed",
    });
  });

  it("refuses a non-synthetic or unsafe fixture before the worker", async () => {
    mocks.fixture.mockResolvedValue(false);
    const response = await POST(request(payload()));
    expect(response.status).toBe(409);
    expect(mocks.process).not.toHaveBeenCalled();
    expect(mocks.sweep).not.toHaveBeenCalled();
    expect(mocks.finish).toHaveBeenCalledWith({ jobId: JOB_ID, claimToken: CLAIM_TOKEN, status: "noop", errorCode: "canary_preflight_failed" });
  });

  it("refuses more than one persisted URL before the worker", async () => {
    mocks.loadUrls.mockResolvedValue([
      { url_key: CANONICAL_URL, lead_id: null, lookup_status: null, authorization_status: null, last_error_code: null },
      { url_key: `${CANONICAL_URL}&second=1`, lead_id: null, lookup_status: null, authorization_status: null, last_error_code: null },
    ]);
    const response = await POST(request(payload()));
    expect(response.status).toBe(409);
    expect(mocks.process).not.toHaveBeenCalled();
  });

  it("refuses a run id whose persisted fixture proof does not match", async () => {
    mocks.fixture.mockResolvedValue(false);
    const response = await POST(request(payload({ runId: "00000000-0000-0000-0000-000000000099" })));
    expect(response.status).toBe(409);
    expect(mocks.fixture).toHaveBeenCalledWith(expect.objectContaining({ runId: "00000000-0000-0000-0000-000000000099" }));
    expect(mocks.process).not.toHaveBeenCalled();
  });

  it("refuses when the exact private execution claim CAS loses", async () => {
    mocks.claimCanary.mockResolvedValue(false);
    const response = await POST(request(payload()));
    expect(response.status).toBe(409);
    await expect(json(response)).resolves.toEqual({ ok: false, stage: "preflight", category: "canary_fence" });
    expect(mocks.process).not.toHaveBeenCalled();
  });

  it("cleans an ambiguous CAS outcome with only the private token", async () => {
    mocks.claimCanary.mockRejectedValue(new Error("connection reset after commit"));
    const response = await POST(request(payload()));
    expect(response.status).toBe(500);
    expect(mocks.process).not.toHaveBeenCalled();
    expect(mocks.finish).toHaveBeenCalledWith(expect.objectContaining({
      jobId: JOB_ID,
      status: "noop",
      errorCode: "canary_preflight_failed",
    }));
    expect((mocks.finish.mock.calls[mocks.finish.mock.calls.length - 1]?.[0] as { claimToken?: string }).claimToken).not.toBe(CLAIM_TOKEN);
  });

  it("finishes the exact claim when preflight uses the whole work window", async () => {
    vi.useFakeTimers();
    try {
      mocks.loadJob.mockImplementation(async () => {
        vi.advanceTimersByTime(35_001);
        return baseJob();
      });
      const response = await POST(request(payload()));
      expect(response.status).toBe(409);
      await expect(json(response)).resolves.toMatchObject({ ok: false, stage: "preflight", category: "work_window" });
      expect(mocks.finish).toHaveBeenCalledWith({ jobId: JOB_ID, claimToken: CLAIM_TOKEN, status: "expired", errorCode: "work_window_expired" });
      expect(mocks.process).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts fixture verification against the handler work window", async () => {
    vi.useFakeTimers();
    try {
      mocks.fixture.mockImplementation(async () => {
        vi.advanceTimersByTime(35_001);
        return true;
      });
      const response = await POST(request(payload()));
      expect(response.status).toBe(409);
      await expect(json(response)).resolves.toMatchObject({ ok: false, stage: "preflight", category: "work_window" });
      expect(mocks.finish).toHaveBeenCalledWith({ jobId: JOB_ID, claimToken: CLAIM_TOKEN, status: "expired", errorCode: "work_window_expired" });
      expect(mocks.process).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a streamed body without a content length header", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(8_193)));
        controller.close();
      },
    });
    const response = await POST(streamRequest(stream));
    expect(response.status).toBe(409);
    expect(mocks.loadJob).not.toHaveBeenCalled();
  });

  it("times out a stalled streamed body", async () => {
    vi.useFakeTimers();
    try {
      const stream = new ReadableStream<Uint8Array>({ start() {} });
      const pending = POST(streamRequest(stream));
      await vi.advanceTimersByTimeAsync(5_001);
      const response = await pending;
      expect(response.status).toBe(409);
      expect(mocks.loadJob).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns a fixed worker work-window result and terminally expires the claim", async () => {
    mocks.process.mockRejectedValue(new Error("slack_unfurl_budget_exhausted"));
    const response = await POST(request(payload()));
    expect(response.status).toBe(409);
    await expect(json(response)).resolves.toMatchObject({ ok: false, stage: "worker", category: "work_window" });
    expect(mocks.finish).toHaveBeenCalledWith(expect.objectContaining({ jobId: JOB_ID, status: "expired", errorCode: "work_window_expired" }));
    expect((mocks.finish.mock.calls[0]?.[0] as { claimToken?: string }).claimToken).not.toBe(CLAIM_TOKEN);
  });

  it("terminally finishes an unexpected worker failure with the private token", async () => {
    mocks.process.mockRejectedValue(new Error("provider failure"));
    const response = await POST(request(payload()));
    expect(response.status).toBe(500);
    expect(mocks.finish).toHaveBeenCalledWith(expect.objectContaining({ jobId: JOB_ID, status: "noop", errorCode: "canary_worker_failed" }));
    expect((mocks.finish.mock.calls[mocks.finish.mock.calls.length - 1]?.[0] as { claimToken?: string }).claimToken).not.toBe(CLAIM_TOKEN);
  });

  it("detects fixture drift after the unchanged worker returns", async () => {
    mocks.fixture.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const response = await POST(request(payload()));
    expect(response.status).toBe(409);
    await expect(json(response)).resolves.toEqual({ ok: false, stage: "post_dispatch", category: "post_dispatch_drift" });
    expect(mocks.process).toHaveBeenCalledTimes(1);
    expect(mocks.loadUrls).toHaveBeenCalledWith(JOB_ID, 2);
  });

  it("calls the unchanged worker exactly once for one current exact job", async () => {
    const response = await POST(request(payload()));
    expect(response.status).toBe(200);
    await expect(json(response)).resolves.toEqual({ ok: true, status: "succeeded" });
    expect(mocks.process).toHaveBeenCalledTimes(1);
    const [job, deadline] = mocks.process.mock.calls[0] as [Record<string, unknown>, number];
    expect(job.id).toBe(JOB_ID);
    expect(deadline).toBeGreaterThan(Date.now());
    expect(deadline - Date.now()).toBeLessThanOrEqual(40_000);
    expect(mocks.claimCanary).toHaveBeenCalledWith(expect.objectContaining({
      jobId: JOB_ID,
      claimToken: CLAIM_TOKEN,
      orgId: ORG_ID,
      propertyId: PROPERTY_ID,
      runId: RUN_ID,
      canonicalURL: CANONICAL_URL,
    }));
    expect((mocks.process.mock.calls[0] as unknown[])[2]).toMatchObject({ canonicalURL: CANONICAL_URL, propertyId: PROPERTY_ID, runId: RUN_ID });
    expect(mocks.sweep).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.cleanup).not.toHaveBeenCalled();
  });
});
