import { describe,it,expect,vi } from "vitest";
import { recoverDialpadPredispatch } from "./start-recovery";
const org="11111111-1111-4111-8111-111111111111";
describe("predispatch recovery",()=>{
  it("calls only the org-scoped atomic recovery RPC with bounded batch",async()=>{
    const rpc=vi.fn().mockResolvedValue({data:{recovered:2,resumed:3},error:null});
    expect(await recoverDialpadPredispatch({rpc},org)).toEqual({recovered:2,resumed:3});
    expect(rpc).toHaveBeenCalledExactlyOnceWith("fn_recover_dialpad_pre_dispatch",{p_org_id:org,p_limit:20});
  });
  it("rejects absent scope or oversized batch without IO",async()=>{
    const rpc=vi.fn();
    await expect(recoverDialpadPredispatch({rpc},"",20)).rejects.toThrow();
    await expect(recoverDialpadPredispatch({rpc},org,101)).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });
  it("does not retry or leak an uncertain RPC failure",async()=>{
    const rpc=vi.fn().mockRejectedValue(new Error("secret URL"));
    await expect(recoverDialpadPredispatch({rpc},org)).rejects.toThrow("Dialpad predispatch recovery was not confirmed");
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it("rejects malformed success instead of claiming recovered state",async()=>{
    for(const data of [null,{recovered:1000,resumed:0},{recovered:1,resumed:-1}]) {
      const rpc=vi.fn().mockResolvedValue({data,error:null});
      await expect(recoverDialpadPredispatch({rpc},org)).rejects.toThrow("not confirmed");
    }
  });
});
