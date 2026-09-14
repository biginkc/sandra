import { describe, expect, it, vi } from "vitest";
import { createSupabaseInboxRepository, type InboxRpcClient } from "./supabase-sync-repository";
const org = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", user = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const authority = { org_id: org, user_id: user, session_id: id, access_epoch: "2", expires_at: "2030-01-01T00:00:00Z", session_active: true, active_membership_count: 1 };
const record = { id, org_id: org, user_id: user, session_id: id, access_epoch: "2", generation: "1", created_at: "2029-12-31T23:45:00Z", expires_at: "2030-01-01T00:00:00Z", targets: [{ kind: "known_conversation", id }], handles: [null], next_cursor: null as string | null, refreshed: false };
const session = { userId: user, sessionId: id, expiresAt: Date.parse(authority.expires_at) };
function fixture() {
  const signals: AbortSignal[] = [];
  const rpc = vi.fn((name: string) => ({ abortSignal: (signal: AbortSignal) => { signals.push(signal); return Promise.resolve({ data: name === "inbox_authorize_sync" ? authority : name === "inbox_bind_sync_handle" ? true : record, error: null }); } }));
  return { rpc, signals, repo: createSupabaseInboxRepository({ rpc } as unknown as InboxRpcClient), signal: new AbortController().signal };
}
describe("cookie client durable Inbox RPC repository", () => {
  it("bootstraps canonical identity in one authenticated RPC without a legacy membership fallback", async () => {
    const f = fixture();
    await expect(f.repo.getContext(f.signal)).resolves.toEqual({ userId: user, sessionId: id, orgId: org, accessEpoch: "2", expiresAt: Date.parse(authority.expires_at) });
    expect(f.rpc.mock.calls).toEqual([["inbox_authorize_sync", { org_id: null }]]);
  });
  it("uses confirmed RPC arguments without a client actor or privileged fallback", async () => {
    const f = fixture();
    const created = await f.repo.createScope(session, { orgId: org, filter: { view: "active" }, cursor: null, limit: 100, replacesScopeId: id }, f.signal);
    expect(f.rpc.mock.calls[1]).toEqual(["inbox_create_workset_v2", { org_id: org, filter: { view: "active" }, limit: 100, replaces_scope_id: id, cursor_id: null }]);
    expect(created.targets).toEqual(record.targets);
    expect(f.signals.every(signal => signal === f.signal)).toBe(true);
  });
  it("passes opaque continuation cursor to SQL and returns canonical continuation metadata", async () => {
    const f = fixture();
    f.rpc.mockImplementation((name: string) => ({ abortSignal: () => Promise.resolve({ data: name === "inbox_authorize_sync" ? authority : { ...record, next_cursor: id, refreshed: true }, error: null }) }));
    const result = await f.repo.createScope(session, { orgId: org, filter: { view: "all", search: "Smith", hide_noise: false }, cursor: id, limit: 100 }, f.signal);
    expect(f.rpc.mock.calls[1]).toEqual(["inbox_create_workset_v2", { org_id: org, filter: { view: "all", search: "Smith", hide_noise: false }, limit: 100, replaces_scope_id: null, cursor_id: id }]);
    expect(result.nextCursor).toBe(id); expect(result.refreshed).toBe(true);
  });
  it("fails closed when schema/grants are unavailable without retrying", async () => {
    const rpc = vi.fn(() => ({ abortSignal: () => Promise.resolve({ data: null, error: { code: "PGRST202", message: "private detail" } }) }));
    const repo = createSupabaseInboxRepository({ rpc } as unknown as InboxRpcClient);
    await expect(repo.authenticate(new Request("https://example.com"), new AbortController().signal)).rejects.toThrow("Inbox unavailable");
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it("rejects malformed opaque cursors before calls", async () => {
    const f = fixture();
    await expect(f.repo.createScope(session, { orgId: org, filter: {}, cursor: "next", limit: 100 }, f.signal)).rejects.toThrow();
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it("denies actor mismatch before creation or handle binding", async () => {
    const f = fixture();
    await expect(f.repo.createScope({ ...session, userId: org }, { orgId: org, filter: {}, cursor: null, limit: 100 }, f.signal)).rejects.toThrow();
    expect(f.rpc).toHaveBeenCalledTimes(1);
    expect(await f.repo.getAccess({ ...session, sessionId: user }, org, f.signal)).toBeNull();
  });
  it("honors prior abort without calling the API", async () => {
    const f = fixture(), controller = new AbortController(); controller.abort();
    await expect(f.repo.getScope(id, controller.signal)).rejects.toThrow();
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it("rejects duplicate typed targets but permits opposite kinds with the same UUID", async () => {
    for (const kind of ["known_conversation", "unknown_sender"]) {
      const rpc = vi.fn(() => ({ abortSignal: () => Promise.resolve({ data: { ...record, targets: [...record.targets, { kind, id }] }, error: null }) }));
      const promise = createSupabaseInboxRepository({ rpc } as unknown as InboxRpcClient).getScope(id, new AbortController().signal);
      if (kind === "known_conversation") await expect(promise).rejects.toThrow();
      else expect((await promise)?.targets).toHaveLength(2);
    }
  });
});
it("preserves exact SQL timestamp precision in atomic finalization proof",async()=>{
  const precise={...record,created_at:"2029-12-31T23:45:00.000123Z",expires_at:"2030-01-01T00:00:00.000123Z"};
  const rpc=vi.fn(()=>({abortSignal:()=>Promise.resolve({data:{authority,scope:precise},error:null})}));
  const repo=createSupabaseInboxRepository({rpc} as unknown as InboxRpcClient),signal=new AbortController().signal;
  const snapshot=await repo.loadAuthorizedScope!(id,signal);expect(snapshot).not.toBeNull();await repo.finalizeAuthorizedScope!(snapshot!,0,null,"handle",signal);
  expect(rpc.mock.calls).toEqual([["inbox_sync_snapshot_v1",{scope_id:id}],["inbox_sync_finalize_v1",{scope_id:id,expected_scope:precise,partition_index:0,expected_handle:null,next_handle:"handle"}]]);
});
