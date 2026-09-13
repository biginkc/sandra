import { describe, expect, it, vi } from "vitest";
import { processDialpadVoiceEvents, type VoiceEventWorkerStore } from "./event-worker";

const intent = "11111111-1111-4111-8111-111111111111";
function fixture(payload: object = {}, attemptCount = 1) {
  const receipt = { id: "receipt", orgId: "org", leaseToken: "lease", attemptCount, payload: {
    call_id: "123", state: "hangup", event_timestamp: 1700000000000,
    target: { id: "456", type: "User" }, direction: "outbound", custom_data: intent, ...payload,
  } };
  const store: VoiceEventWorkerStore = {
    claim: vi.fn().mockResolvedValue([receipt]), recordEvidence: vi.fn().mockResolvedValue(undefined),
    enqueueRecordings: vi.fn().mockResolvedValue(undefined), ingestInsights: vi.fn().mockResolvedValue(undefined), finish: vi.fn().mockResolvedValue(true),
  };
  const run = () => processDialpadVoiceEvents({ store, orgId: "org", providerUserId: "456", now: () => 1700000000000 });
  return { store, receipt, run };
}
describe("Dialpad event processing", () => {
  it("records provider evidence and queues artifacts before finishing", async () => {
    const { store, run } = fixture();
    expect((await run()).processed).toBe(1);
    expect(store.recordEvidence).toHaveBeenCalledWith(intent, "receipt");
    expect(vi.mocked(store.enqueueRecordings).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(store.finish).mock.invocationCallOrder[0]);
  });
  it("retains inbound audio without inventing acquisition credit", async () => {
    const { store, run } = fixture({ direction: "inbound" });
    expect((await run()).processed).toBe(1);
    expect(store.recordEvidence).not.toHaveBeenCalled();
    expect(store.enqueueRecordings).toHaveBeenCalledOnce();
  });
  it("quarantines unidentified targets without any effect", async () => {
    const { store, run } = fixture({ target: {} });
    expect((await run()).quarantined).toBe(1);
    expect(store.enqueueRecordings).not.toHaveBeenCalled();
    expect(store.recordEvidence).not.toHaveBeenCalled();
  });
  it("retries an artifact failure even after evidence succeeded", async () => {
    const { store, receipt, run } = fixture();
    vi.mocked(store.enqueueRecordings).mockRejectedValueOnce(Error("private failure"));
    expect((await run()).retry).toBe(1);
    expect(store.finish).toHaveBeenCalledWith(receipt, { status: "retry", errorCode: "processing_unavailable", retryAt: "2023-11-14T22:13:35.000Z" });
  });
  it("limits retries and does not count a lost lease as processed", async () => {
    const failed = fixture({}, 8);
    vi.mocked(failed.store.recordEvidence).mockRejectedValue(Error("unavailable"));
    expect((await failed.run()).failed).toBe(1);
    const lost = fixture();
    vi.mocked(lost.store.finish).mockResolvedValueOnce(false);
    expect(await lost.run()).toMatchObject({ processed: 0, leaseLost: 1 });
  });
  it("ingests a summary without attempting unsupported start evidence", async () => {
    const { store, run } = fixture({ state: "recap_summary", recap_summary: "fixture summary" });
    expect((await run()).processed).toBe(1);
    expect(store.recordEvidence).not.toHaveBeenCalled();
    expect(store.ingestInsights).toHaveBeenCalledOnce();
  });
  it("retries transcript ingestion failure rather than acknowledging lost artifacts", async () => {
    const { store, run } = fixture({ state: "call_transcription" });
    vi.mocked(store.ingestInsights).mockRejectedValueOnce(Error("unavailable"));
    expect((await run()).retry).toBe(1);
  });
});
