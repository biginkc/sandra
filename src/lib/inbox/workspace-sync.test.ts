import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceSync, workspaceRequestSignal, summaryRow, type WorkspaceScope } from "./workspace-sync";
import { workspaceId } from "@/components/inbox-workspace/selection";
const org = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const target = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const scope: WorkspaceScope = { scopeId: target, orgId: org, requesterId: org, sessionId: "session-a", accessEpoch: "1", expiresAt: Date.now()+60000, orderedIds: [workspaceId({ kind: "conversation", orgId: org, conversationId: target })] };
const summary = { org_id: org, target_kind: "known_conversation" as const, target_id: target, name: "Name", context: "Context", preview: "Preview", time_label: "Now", outcome_label: "New", assigned_label: "Unassigned", unread: true };
const cleaners: (()=>void)[] = [];
afterEach(()=> { cleaners.splice(0).forEach(fn=>fn()); vi.useRealTimers(); });
function setup(fetcher: typeof fetch) {
  const boundary = vi.fn(); const change = vi.fn();
  const sync = createWorkspaceSync({origin:"https://sandra.example",fetch:fetcher,onAccessBoundary:boundary,onChange:change});
  cleaners.push(sync.close); return {sync,boundary,change};
}
const tick = () => new Promise(resolve=>setTimeout(resolve,20));
describe("bounded workspace synchronization lifecycle",()=> {
  it("rejects delivery after expiry even when the expiry timer has not run",async()=> {
    let deliver:((response:Response)=>void)|undefined;
    const {sync}=setup(vi.fn<typeof fetch>(()=>new Promise<Response>(resolve=>{deliver=resolve;})));
    sync.replace(scope); await tick();
    vi.useFakeTimers({toFake:["Date"]}); vi.setSystemTime(scope.expiresAt+1);
    const expiredResponse = new Response(JSON.stringify([{key:"one",headers:{operation:"insert"},value:summary},{headers:{control:"up-to-date",global_last_seen_lsn:"0"}}]),{headers:{"content-type":"application/json","electric-handle":"expiry-shape","electric-offset":"0_0","electric-schema":"{}","electric-cursor":"1"}});
    const clone = vi.spyOn(expiredResponse,"clone");
    deliver!(expiredResponse);
    await tick(); expect(sync.getSnapshot()).toEqual({state:"resync_required",rows:[]});
    expect(clone).not.toHaveBeenCalled();
  });
  it("keeps caller and Request cancellation without aborting the scope",()=> {
    const scopeAbort = new AbortController(); const callerAbort = new AbortController();
    const requestAbort = new AbortController();
    const request = new Request("https://sandra.example/api/inbox/sync/test", {signal:requestAbort.signal});
    const first = workspaceRequestSignal(request,{signal:callerAbort.signal},scopeAbort.signal);
    callerAbort.abort(); expect(first.aborted).toBe(true); expect(scopeAbort.signal.aborted).toBe(false);
    const second = workspaceRequestSignal(request,undefined,scopeAbort.signal);
    expect(second.aborted).toBe(false); requestAbort.abort();
    expect(second.aborted).toBe(true); expect(scopeAbort.signal.aborted).toBe(false);
  });
  it("applies partial UPDATE and DELETE through the pinned collection protocol",async()=> {
    let requests=0; let next: ((response:Response)=>void)|undefined;
    const response = (messages:unknown[],offset:string)=>new Response(JSON.stringify([...messages,{headers:{control:"up-to-date",global_last_seen_lsn:"0"}}]),{headers:{"content-type":"application/json","electric-handle":"test-shape","electric-offset":offset,"electric-schema":"{}","electric-cursor":"1"}});
    const fetcher=vi.fn<typeof fetch>(()=> {
      if(++requests===1) return Promise.resolve(response([{key:"row-one",headers:{operation:"insert"},value:summary}],"0_0"));
      return new Promise<Response>(resolve=>{next=resolve;});
    });
    const {sync}=setup(fetcher); sync.replace(scope);
    await vi.waitFor(()=>expect(sync.getSnapshot().state).toBe("live"));
    await vi.waitFor(()=>expect(next).toBeDefined());
    const update=next!; next=undefined;
    update(response([{key:"row-one",headers:{operation:"update"},value:{org_id:org,target_id:target,target_kind:"known_conversation",preview:"Updated"}}],"1_0"));
    await vi.waitFor(()=>expect(sync.getSnapshot().rows[0].preview).toBe("Updated"));
    expect(sync.getSnapshot().rows[0].name).toBe("Name");
    await vi.waitFor(()=>expect(next).toBeDefined());
    next!(response([{key:"row-one",headers:{operation:"delete"},value:{org_id:org,target_id:target,target_kind:"known_conversation"}}],"2_0"));
    await vi.waitFor(()=>expect(sync.getSnapshot().rows).toEqual([]));
  });
  it("hydrates through actual Electric and TanStack collection then clears on reset",async()=> {
    let requests=0;
    const fetcher=vi.fn<typeof fetch>(()=> {
      requests++;
      if(requests>1) return new Promise<Response>(()=>{});
      return Promise.resolve(new Response(JSON.stringify([
        {key:"row-one",headers:{operation:"insert"},value:summary},
        {headers:{control:"up-to-date",global_last_seen_lsn:"0"}}
      ]), {headers:{"content-type":"application/json","electric-handle":"test-shape","electric-offset":"0_0","electric-schema":"{}","electric-cursor":"1"}}));
    });
    const {sync}=setup(fetcher); sync.replace({...scope,scopeId:"cccccccc-cccc-4ccc-8ccc-cccccccccccc"});
    await vi.waitFor(()=>expect(sync.getSnapshot().state).toBe("live"));
    expect(sync.getSnapshot().rows).toEqual([summaryRow(summary)]);
    sync.reset(); expect(sync.getSnapshot()).toEqual({state:"resync_required",rows:[]});
  });
  it("maps both typed targets without dropping tenant identity",()=> {
    expect(summaryRow(summary).target).toEqual({kind:"conversation",orgId:org,conversationId:target});
    expect(summaryRow({...summary,target_kind:"unknown_sender"}).target).toEqual({kind:"unknown_sender_group",orgId:org,senderGroupId:target});
    expect(()=>summaryRow({...summary,preview:"a".repeat(2001)})).toThrow();
  });
  it("rejects overflowing, duplicate, expired and foreign tenant memberships before transport",()=> {
    const fetcher=vi.fn<typeof fetch>(); const {sync}=setup(fetcher);
    for (const bad of [{...scope,orderedIds:Array(501).fill(scope.orderedIds[0])},{...scope,orderedIds:[...scope.orderedIds,...scope.orderedIds]},{...scope,expiresAt:0},{...scope,orgId:target}]) expect(()=>sync.replace(bad)).toThrow();
    expect(fetcher).not.toHaveBeenCalled(); expect(sync.getSnapshot().rows).toEqual([]);
  });
  it("aborts obsolete requests and ignores late authorization denial from replaced session",async()=> {
    const pending: {resolve:(r:Response)=>void;signal:AbortSignal}[]=[];
    const {sync,boundary}=setup(vi.fn((_request,init)=>new Promise<Response>(resolve=>pending.push({resolve,signal:init!.signal!}))));
    sync.replace(scope); await tick();
    sync.replace({...scope,sessionId:"session-b"}); await tick();
    expect(pending[0].signal.aborted).toBe(true); expect(boundary).toHaveBeenCalledTimes(1);
    pending[0].resolve(new Response(null,{status:403})); await tick();
    expect(sync.getSnapshot().state).toBe("loading"); expect(boundary).toHaveBeenCalledTimes(1);
  });
  it("revocation clears state immediately and terminates the transport",async()=> {
    let signal:AbortSignal|undefined;
    const {sync,boundary}=setup(vi.fn((_r,init)=>{signal=init!.signal!;return new Promise<Response>(()=>{});}));
    sync.replace(scope); await tick(); sync.revoke();
    expect(signal!.aborted).toBe(true); expect(sync.getSnapshot()).toEqual({state:"permission_lost",rows:[]}); expect(boundary).toHaveBeenCalledOnce();
  });
  it.each([403,410,409,413,429])("fails closed for gateway status %i without retrying an old scope",async(status)=> {
    const fetcher=vi.fn<typeof fetch>().mockResolvedValue(new Response(null,{status})); const {sync}=setup(fetcher);
    sync.replace(scope); await tick(); expect(sync.getSnapshot().state).toBe(status===403?"permission_lost":"resync_required"); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects cross-tenant snapshot values before publishing",async()=> {
    const {sync}=setup(vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify([{headers:{operation:"insert"},value:{...summary,org_id:target}}]),{headers:{"content-type":"application/json"}})));
    sync.replace(scope); await tick(); expect(sync.getSnapshot()).toEqual({state:"permission_lost",rows:[]});
  });
  it("clears reset snapshots instead of retaining old shape handles",async()=> {
    const {sync}=setup(vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify([{headers:{control:"must-refetch"}}]),{headers:{"content-type":"application/json"}})));
    sync.replace(scope); await tick(); expect(sync.getSnapshot()).toEqual({state:"resync_required",rows:[]});
  });
});
