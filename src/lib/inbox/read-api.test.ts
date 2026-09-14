import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createInboxReadRepository, type InboxReadClient } from "./read-api";
import wrapperEvidence from "../../../experiments/inbox-post-render-read/wrapper-evidence.json";
const org = "11111111-1111-1111-1111-111111111111";
const conversation = "22222222-2222-2222-2222-222222222222";
const boundary = "33333333-3333-3333-3333-333333333333";
const signal = () => new AbortController().signal;
function client(responses: unknown[]) {
  const rpc = vi.fn(() => ({ abortSignal: vi.fn(async () => {
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response;
  }) }));
  return { rpc, repository: createInboxReadRepository({ rpc } as unknown as InboxReadClient) };
}
const receipt = { boundary_id: boundary, batch: 0, changed: 200, completed: false };
const snapshot = {
  requester_id: boundary, org_id: org, conversation_id: conversation, head_revision: "9007199254740993",
  read_boundary: boundary, boundary_expires_at: "2030-01-01T00:00:00Z", capture_generation: boundary, next_cursor: null,
  history: [{ id: boundary, created_at_raw: "2026-09-13 12:00:00.123456+00", body: "Owned test", direction: "inbound", read_at_raw: null, inbound_revision: "9007199254740993" }],
};
describe("canonical Inbox read RPC repository", () => {
  it("decodes retained real canonical mixed-history and receipt scalars (mock HTTP transport)", async () => {
    const raw = wrapperEvidence.scalar_detail;
    const { repository } = client([{ data: { ...raw, next_cursor: null }, error: null }, { data: wrapperEvidence.scalar_acknowledgment, error: null }]);
    const detail = await repository.detail(raw.org_id, raw.conversation_id, signal());
    expect(detail.history.map(row => [row.direction, row.inboundRevision])).toEqual([["inbound", "1"], ["outbound", "0"]]);
    expect((await repository.acknowledge(raw.read_boundary, 0, signal())).changed).toBe(1);
  });
  it("preserves microsecond timestamps and revisions above JS integer precision", async () => {
    const { repository, rpc } = client([{ data: snapshot, error: null }]);
    const result = await repository.detail(org, conversation, signal());
    expect(result.history[0].createdAtRaw).toBe(snapshot.history[0].created_at_raw);
    expect(result.headRevision).toBe("9007199254740993");
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith("inbox_history_page", { org_id: org, conversation_id: conversation });
  });
  it("sends only an opaque cursor and validates the next cursor", async () => {
    const { repository, rpc } = client([{ data: { ...snapshot, next_cursor: org }, error: null }]);
    expect((await repository.detail(org, conversation, signal(), boundary)).nextCursor).toBe(org);
    expect(rpc).toHaveBeenCalledWith("inbox_history_page", { org_id: org, conversation_id: conversation, before_cursor: boundary });
    await expect(client([]).repository.detail(org, conversation, signal(), "arbitrary-date")).rejects.toMatchObject({ status: 400 });
    await expect(client([{ data: { ...snapshot, next_cursor: "bad" }, error: null }]).repository.detail(org, conversation, signal())).rejects.toMatchObject({ status: 503 });
  });
  it("rejects cross-conversation results and oversized history", async () => {
    for (const value of [{ ...snapshot, conversation_id: org }, { ...snapshot, history: Array(51).fill(snapshot.history[0]) }]) {
      await expect(client([{ data: value, error: null }]).repository.detail(org, conversation, signal())).rejects.toMatchObject({ status: 503 });
    }
  });
  it("accepts outbound zero revisions and refuses missing canonical revision coverage", async () => {
    const outbound = { ...snapshot.history[0], id: org, direction: "outbound", inbound_revision: "0" };
    const result = await client([{ data: { ...snapshot, history: [...snapshot.history, outbound] }, error: null }]).repository.detail(org, conversation, signal());
    expect(result.history[1].inboundRevision).toBe("0");
    for (const direction of ["inbound", "outbound"]) {
      await expect(client([{ data: { ...snapshot, history: [{ ...outbound, direction, inbound_revision: null }] }, error: null }]).repository.detail(org, conversation, signal())).rejects.toMatchObject({ status: 503 });
    }
  });
  it("retries fresh whole RPC transactions only for explicit aborted database codes", async () => {
    const { repository, rpc } = client([{ error: { code: "40P01" } }, { error: { code: "40001" } }, { data: receipt, error: null }]);
    expect(await repository.acknowledge(boundary, 0, signal())).toEqual({ boundaryId: boundary, batch: 0, changed: 200, completed: false });
    expect(rpc).toHaveBeenCalledTimes(3);
    for (const args of rpc.mock.calls) expect(args).toEqual(["inbox_acknowledge_read", { boundary_id: boundary, batch_number: 0 }]);
  });
  it("does not automatically retry a lost response or unknown failure", async () => {
    for (const response of [new Error("Lost response"), { error: { code: "08006", message: "Connection lost" } }]) {
      const { repository, rpc } = client([response]);
      await expect(repository.acknowledge(boundary, 0, signal())).rejects.toBeDefined();
      expect(rpc).toHaveBeenCalledOnce();
    }
  });
  it("rejects mismatched receipt identities instead of advancing progress", async () => {
    const { repository } = client([{ data: { ...receipt, batch: 1 }, error: null }]);
    await expect(repository.acknowledge(boundary, 0, signal())).rejects.toMatchObject({ status: 503 });
  });
  it.each([
    ["42501", "INBOX_SESSION_REVOKED", 401], ["42501", "INBOX_READ_NOT_FOUND", 404],
    ["42501", "INBOX_ACCESS_DENIED", 404],
    ["42501", "INBOX_ORG_DENIED", 403], ["42501", "INBOX_MEMBERSHIP_AMBIGUOUS_OR_MISSING", 403],
    ["42501", "INBOX_ACCESS_BASELINE_MISSING", 403],
    ["55000", "INBOX_READ_EXPIRED", 410], ["55000", "INBOX_READ_BATCH_CONFLICT", 409],
    ["42501", "permission denied for function", 503], ["PGRST202", "Missing schema", 503],
    ["PGRST301", "JWT invalid", 401], ["PGRST303", "JWT expired", 401],
  ])("maps exact database denial %s/%s to %s", async (code, message, status) => {
    await expect(client([{ error: { code, message } }]).repository.acknowledge(boundary, 0, signal())).rejects.toMatchObject({ status });
  });
  it("refuses invalid input and pre-aborted requests before RPC invocation", async () => {
    const { repository, rpc } = client([]);
    await expect(repository.acknowledge(boundary, -1, signal())).rejects.toMatchObject({ status: 400 });
    const controller = new AbortController(); controller.abort();
    await expect(repository.acknowledge(boundary, 0, controller.signal)).rejects.toBeDefined();
    expect(rpc).not.toHaveBeenCalled();
  });
});
