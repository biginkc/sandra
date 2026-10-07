import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { reconcileRecordings, recordingEvidence } from "./recording-reconcile";
const claim = { request_id: "request-1", attempt: 1, provider_call_id: "call-1", phone_e164: "+18165551001", lookup_attempts: 1, lease_id: "lease-1" };
const body = { call_id: "call-1", inbound: false, to: claim.phone_e164, completed: true };
function setup(claims = [claim]) {
  const rpc = vi.fn(async (name: string) => ({ data: name === "fn_norma_claim_recordings" ? claims : true, error: null }));
  const client = { rpc } as unknown as SupabaseClient<Database>;
  const fetcher = vi.fn(async () => Response.json(body));
  return { rpc, client, fetcher };
}
describe("durable outbound recording reconciliation", () => {
  it("keeps delayed recordings pending, then stores availability without a media URL", async () => {
    const { rpc, client, fetcher } = setup();
    await reconcileRecordings(client, "secret", fetcher);
    expect(rpc).toHaveBeenCalledWith("fn_norma_checkpoint_recording", expect.objectContaining({ p_state: "pending", p_call_id: "call-1", p_attempt: 1 }));
    fetcher.mockResolvedValue(Response.json({ ...body, recording_url: "https://expiring.invalid/secret" }));
    expect(await reconcileRecordings(client, "secret", fetcher)).toMatchObject({ available: 1 });
    expect(JSON.stringify(rpc.mock.calls)).not.toContain("expiring.invalid");
    expect(fetcher).toHaveBeenCalledWith("https://api.bland.ai/v1/calls/call-1", expect.objectContaining({ method: "GET", redirect: "error", cache: "no-store" }));
  });
  it.each([401,403])("persists pause and stops the entire batch on %i without trying another call", async(status) => {
    const { rpc, client, fetcher } = setup([claim,{ ...claim, provider_call_id: "call-2", attempt: 2 }]);
    fetcher.mockResolvedValue(new Response("private", { status }));
    expect(await reconcileRecordings(client,"secret",fetcher)).toMatchObject({ checked: 1, denied: 1 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenLastCalledWith("fn_norma_finish_recording_lookup",{ p_lease_id: "lease-1",p_denied: true });
    expect(rpc.mock.calls.some(([name]) => name === "fn_norma_checkpoint_recording")).toBe(false);
  });
  it.each([
    [{ ...body,call_id:"other",recording_url:"url" },null],
    [{ ...body,inbound:true,recording_url:"url" },null],
    [{ ...body,to:"+18165559999",recording_url:"url" },null],
    [{ ...body,metadata:{request_id:"other"},recording_url:"url" },null],
    [{ ...body,record:false },"not_recorded"],
    [{ ...body,recording_url:"   " },"pending"],
  ])("validates provider identity before accepting evidence %#",(value,expected) => {
    expect(recordingEvidence(value,claim)).toBe(expected);
  });
  it.each([200,404,500])("finishes missing/failed lookups at the bounded retry count (%i)",async(status) => {
    const {rpc,client,fetcher}=setup([{...claim,lookup_attempts:6}]);
    fetcher.mockResolvedValue(Response.json(body,{status}));
    await reconcileRecordings(client,"secret",fetcher);
    expect(rpc).toHaveBeenCalledWith("fn_norma_checkpoint_recording",expect.objectContaining({p_state:status===500?"failed":"unavailable"}));
  });
  it("bounds malformed and oversized provider JSON and never leaks it",async() => {
    const {rpc,client,fetcher}=setup();
    for(const response of [new Response("malformed-secret"),new Response("x".repeat(4*1024*1024+1))]) {
      fetcher.mockResolvedValue(response);await reconcileRecordings(client,"secret",fetcher);
    }
    expect(rpc).toHaveBeenCalledWith("fn_norma_checkpoint_recording",expect.objectContaining({p_state:"pending"}));
    expect(JSON.stringify(rpc.mock.calls)).not.toContain("malformed-secret");
  });
  it("releases the lease on network failure and preserves the retry budget",async() => {
    const {rpc,client,fetcher}=setup();fetcher.mockRejectedValue(new Error("private"));
    await reconcileRecordings(client,"secret",fetcher);
    expect(rpc).toHaveBeenLastCalledWith("fn_norma_finish_recording_lookup",{p_lease_id:"lease-1",p_denied:false});
  });
  it("does no provider work without a claim",async() => {
    const {client,fetcher}=setup([]);await reconcileRecordings(client,"secret",fetcher);expect(fetcher).not.toHaveBeenCalled();
  });
  it("does not continue when the checkpoint loses its lease",async() => {
    const {rpc,client,fetcher}=setup([claim,{...claim,attempt:2}]);
    rpc.mockImplementation(async(name) => ({data:name==="fn_norma_claim_recordings"?[claim,{...claim,attempt:2}]:name==="fn_norma_start_recording_lookup",error:null}));
    await reconcileRecordings(client,"secret",fetcher);expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("never contacts the provider when the write-ahead admission fails",async() => {
    const {rpc,client,fetcher}=setup();
    rpc.mockImplementation(async(name) => ({data:name==="fn_norma_claim_recordings"?[claim]:false,error:null}));
    await reconcileRecordings(client,"secret",fetcher);expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not continue after denial even if cancelling the response throws",async() => {
    const {rpc,client,fetcher}=setup([claim,{...claim,attempt:2}]);
    fetcher.mockResolvedValue(new Response(new ReadableStream({cancel(){throw new Error("cancel failed");}}),{status:403}));
    expect(await reconcileRecordings(client,"secret",fetcher)).toMatchObject({denied:1,checked:1});
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenLastCalledWith("fn_norma_finish_recording_lookup",{p_lease_id:"lease-1",p_denied:true});
  });

});
