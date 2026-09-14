import { describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { DialpadVoiceDatabase } from "./database.generated";
import { resolveDialpadRecordingStatus } from "./recording-status";
function harness(status: string | null, failed=false) {
  const fetcher=vi.fn<typeof fetch>().mockResolvedValue(Response.json(failed ? {message:"private"} : status ? {status} : null,{status:failed?500:200}));
  const client=createClient<DialpadVoiceDatabase>("https://fixture.supabase.co","fixture-key",{global:{fetch:fetcher},auth:{persistSession:false,autoRefreshToken:false}});
  return {client,fetcher};
}
describe("Dialpad recording processing status",()=>{
  it("reports any denied or exhausted required segment as failed with scoped metadata only",async()=>{
    for(const status of ["denied","failed"]) {
      const h=harness(status);
      expect(await resolveDialpadRecordingStatus(h.client,"org","123",false)).toBe("failed");
      const url=new URL(String(h.fetcher.mock.calls[0][0]));
      expect(Object.fromEntries(url.searchParams)).toMatchObject({select:"status",org_id:"eq.org",provider_call_id:"eq.123",status:"in.(denied,failed)",limit:"1"});
    }
  });
  it("lets authoritative completeness win without another query",async()=>{
    const h=harness("failed");expect(await resolveDialpadRecordingStatus(h.client,"org","123",true)).toBe("available");expect(h.fetcher).not.toHaveBeenCalled();
  });
  it("keeps absence of failures pending and never infers no recording",async()=>{
    const h=harness(null);expect(await resolveDialpadRecordingStatus(h.client,"org","123",false)).toBe("pending");
  });
  it("sanitizes lookup failures instead of fabricating pending",async()=>{
    const h=harness(null,true);await expect(resolveDialpadRecordingStatus(h.client,"org","123",false)).rejects.toThrow("Recording processing status unavailable");
  });
});
