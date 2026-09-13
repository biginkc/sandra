import { describe, expect, it, vi } from "vitest";
import { createInboxSyncGateway, type InboxSyncRepository, type DurableInboxScope, type InboxAccess } from "./sync-gateway";
const org="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",id="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",user="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
function fixture() {
  let now=1000;
  const scope:DurableInboxScope={id,orgId:org,userId:user,sessionId:"session",accessEpoch:"e1",generation:"g1",expiresAt:100000,targets:[{kind:"known_conversation",id}],handle:null};
  const access:InboxAccess={sessionActive:true,activeMembershipCount:1,status:"active",epoch:"e1",expiresAt:null,deletionPrepared:false};
  const repo:InboxSyncRepository={authenticate:vi.fn(async()=>({userId:user,sessionId:"session",expiresAt:100000})),getAccess:vi.fn(async()=>access),getScope:vi.fn(async()=>scope),bindHandle:vi.fn(async()=>true)};
  const fetcher=vi.fn<typeof fetch>().mockImplementation(async()=>new Response("[]",{headers:{"electric-handle":"handle-one","electric-offset":"0_0","x-secret":"private"}}));
  const make=(extra={})=>createInboxSyncGateway({repository:repo,electricUrl:"http://127.0.0.1:58783/v1/shape",projectionTable:"public.inbox_flattened",fetch:fetcher,now:()=>now,...extra});
  const request=(query="")=>new Request(`https://sandra.example/api/inbox/sync/${id}${query}`);
  return {scope,access,repo,fetcher,make,request,advance:(n:number)=>{now+=n;}};
}
describe("Inbox gateway durable authorization boundary",()=>{
  it.each(["deleted","replaced"])("denies durable scope %s after upstream response without a new handle",async(mode)=>{
    const f=fixture();f.fetcher.mockImplementation(async()=>{
      if(mode==="deleted")f.repo.getScope=async()=>null;
      else f.repo.getScope=async()=>({...f.scope,generation:"replacement"});
      return new Response("must-not-forward");
    });
    const response=await f.make()(f.request(),id);
    expect(response.status).toBe(403);expect(await response.text()).not.toContain("must-not-forward");
    expect(f.repo.bindHandle).not.toHaveBeenCalled();
  });
  it.each(["fetch","body"])("aborts stalled %s through the actual lease timer",async(mode)=>{
    const f=fixture();let aborted=false;
    f.repo.authenticate=async()=>({userId:user,sessionId:"session",expiresAt:1020});
    f.fetcher.mockImplementation(async(_r,init)=>{
      const signal=init!.signal!;
      if(mode==="fetch")return new Promise<Response>((_resolve,reject)=>signal.addEventListener("abort",()=>{aborted=true;reject(new DOMException("Aborted","AbortError"));},{once:true}));
      return new Response(new ReadableStream({start(controller){signal.addEventListener("abort",()=>{aborted=true;controller.error(new DOMException("Aborted","AbortError"));},{once:true});}}));
    });
    const before=Date.now();const response=await f.make()(f.request(),id);
    expect(response.status).toBe(503);expect(aborted).toBe(true);expect(Date.now()-before).toBeLessThan(1000);
  });
  it("accepts all 500 typed targets within explicit upstream URL budget",async()=>{
    const f=fixture();f.scope.targets=Array.from({length:500},(_,i)=>({kind:i%2?"known_conversation":"unknown_sender",id:`00000000-0000-4000-8000-${i.toString(16).padStart(12,"0")}`}));
    expect((await f.make()(f.request(),id)).status).toBe(200);
    expect(new TextEncoder().encode(String(f.fetcher.mock.calls[0][0])).length).toBeLessThan(65536);
  });
  it("copies scope identity across repository awaits",async()=>{
    const f=fixture();f.repo.getAccess=async()=>{f.scope.orgId=user;return f.access;};
    expect((await f.make()(f.request(),id)).status).toBe(403);
    const url=new URL(String(f.fetcher.mock.calls[0][0]));expect(url.searchParams.get("params[1]")).toBe(org);
  });
  it("returns bounded denial when stream cancellation never resolves",async()=>{
    const f=fixture();let aborted=false;
    f.fetcher.mockImplementation(async(_request,init)=>{init!.signal!.addEventListener("abort",()=>{aborted=true;});return new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(5));},cancel(){return new Promise(()=>{});}}));});
    expect((await f.make({maxResponseBytes:4})(f.request(),id)).status).toBe(413);expect(aborted).toBe(true);
  });
  it("constructs exact typed SQL and hides upstream headers",async()=>{
    const f=fixture();const result=await f.make()(f.request(),id);
    expect(result.status).toBe(200);expect(result.headers.get("x-secret")).toBeNull();
    const url=new URL(String(f.fetcher.mock.calls[0][0]));
    expect(url.searchParams.get("where")).toBe("org_id = $1 AND ((target_kind = 'known_conversation' AND target_id IN ($2)))");
    expect(url.searchParams.get("params[2]")).toBe(id);
    expect(url.searchParams.get("columns")).not.toContain("summary");
    expect(f.repo.bindHandle).toHaveBeenCalled();expect(f.repo.getAccess).toHaveBeenCalledTimes(3);
  });
  it.each(["?where=true","?table=messages","?offset=-1&offset=-1","?handle=stolen&offset=1_0"])("rejects browser scope broadening %s",async(query)=>{
    const f=fixture();expect((await f.make()(f.request(query),id)).status).toBeGreaterThanOrEqual(400);expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("denies ambiguous global membership and unknown authority",async()=>{
    const f=fixture();f.access.activeMembershipCount=2;expect((await f.make()(f.request(),id)).status).toBe(403);
    f.repo.getAccess=async()=>null;expect((await f.make()(f.request(),id)).status).toBe(403);expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("rechecks revocation after buffering before any body delivery",async()=>{
    const f=fixture();f.fetcher.mockImplementation(async()=>{f.access.status="revoked";return new Response("private-body");});
    const response=await f.make()(f.request(),id);expect(response.status).toBe(403);expect(await response.text()).not.toContain("private-body");
  });
  it("rejects a delayed response after the fifteen second deadline",async()=>{
    const f=fixture();f.fetcher.mockImplementation(async()=>{f.advance(15001);return new Response("private-body");});
    expect((await f.make()(f.request(),id)).status).toBe(503);
  });
  it("honors session expiry shorter than the maximum lease",async()=>{
    const f=fixture();f.repo.authenticate=async()=>({userId:user,sessionId:"session",expiresAt:1005});
    f.fetcher.mockImplementation(async()=>{f.advance(6);return new Response("[]");});
    expect((await f.make()(f.request(),id)).status).toBe(403);
  });
  it("fails closed on handle compare-set conflict",async()=>{
    const f=fixture();f.repo.bindHandle=async()=>false;expect((await f.make()(f.request(),id)).status).toBe(409);
  });
  it("bounds actual response bytes and upstream URL before forwarding",async()=>{
    const f=fixture();f.fetcher.mockResolvedValue(new Response("12345"));expect((await f.make({maxResponseBytes:4})(f.request(),id)).status).toBe(413);
    f.fetcher.mockClear();expect((await f.make({maxUpstreamUrlBytes:20})(f.request(),id)).status).toBe(413);expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("denies unauthorized session identity without transport",async()=>{
    const f=fixture();f.scope.sessionId="other";expect((await f.make()(f.request(),id)).status).toBe(403);expect(f.fetcher).not.toHaveBeenCalled();
  });
});
