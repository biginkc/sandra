import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createInboxReadRepository, type InboxReadClient } from "./read-api";
const org = "11111111-1111-1111-1111-111111111111", group = "22222222-2222-2222-2222-222222222222";
const row = { requester_id: org, org_id: org, sender_group_id: group, raw_sender: " +1 raw ", expires_at: "2030-01-01T00:00:00Z", next_cursor: null,
  history: [{ id: group, created_at_raw: "2026-09-13 12:00:00.123456+00", body: "Owned history", direction: "inbound", dismissed_at_raw: null }] };
function fixture(data: unknown) {
  const rpc = vi.fn(() => ({ abortSignal: vi.fn(async () => ({ data, error: null })) }));
  return { rpc, repository: createInboxReadRepository({ rpc } as unknown as InboxReadClient) };
}
it("loads raw sender history by opaque group ID without acknowledgment", async () => {
  const { repository, rpc } = fixture(row);
  const result = await repository.unknownHistory(org, group, new AbortController().signal, org);
  expect(result.rawSender).toBe(" +1 raw "); expect(result.history[0].createdAtRaw).toBe(row.history[0].created_at_raw);
  expect(rpc).toHaveBeenCalledExactlyOnceWith("inbox_unknown_history_page", { org_id: org, sender_group_id: group, before_cursor: org });
  expect(result).not.toHaveProperty("readBoundary");
});
function oversizedHistory(count: number) {
  return Array.from({ length: count }, (_, index) => ({ ...row.history[0], id: `33333333-3333-3333-3333-${String(index).padStart(12, "0")}` }));
}
it("rejects foreign identity, duplicate or oversized history and invalid cursor", async () => {
  for (const data of [{ ...row, org_id: group }, { ...row, sender_group_id: org }, { ...row, history: [row.history[0], row.history[0]] }, { ...row, history: oversizedHistory(51) }, { ...row, next_cursor: "invalid" }]) {
    await expect(fixture(data).repository.unknownHistory(org, group, new AbortController().signal)).rejects.toMatchObject({ status: 503 });
  }
  const { rpc, repository } = fixture(row);
  await expect(repository.unknownHistory(org, group, new AbortController().signal, "date")).rejects.toMatchObject({ status: 400 });
  expect(rpc).not.toHaveBeenCalled();
});
