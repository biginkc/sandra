import {describe,expect,it} from "vitest";
import {inboxSyncUpstream} from "./sync-upstream-config";
const env={NODE_ENV:"production",INBOX_ELECTRIC_SHAPE_URL:"https://relay.example/v1/shape",INBOX_ELECTRIC_PROJECTION_TABLE:"inbox_bridge.summaries",INBOX_ELECTRIC_RELAY_TOKEN:"a".repeat(64)} as NodeJS.ProcessEnv;
describe("private sync relay configuration",()=>{
 it("adds a server-only Bearer header without putting the token in the URL",()=>{const config=inboxSyncUpstream(env);expect(config.upstreamHeaders).toEqual({authorization:`Bearer ${env.INBOX_ELECTRIC_RELAY_TOKEN}`});expect(config.electricUrl).not.toContain(env.INBOX_ELECTRIC_RELAY_TOKEN!);});
 it.each([undefined,"short","a".repeat(257),"bad\nheader"+"a".repeat(32)])("fails closed for invalid token %s",token=>expect(()=>inboxSyncUpstream({...env,INBOX_ELECTRIC_RELAY_TOKEN:token})).toThrow());
 it.each(["http://relay.example/v1/shape","https://user:pass@relay.example/v1/shape","https://relay.example/v1/shape?token=secret","https://relay.example/other"])("rejects unsafe relay endpoint %s",url=>expect(()=>inboxSyncUpstream({...env,INBOX_ELECTRIC_SHAPE_URL:url})).toThrow());
 it("requires an explicit dev/test loopback profile and never sends a relay secret there",()=>{const local: NodeJS.ProcessEnv={...env,NODE_ENV:"development",INBOX_ELECTRIC_UPSTREAM_MODE:"owned-local",INBOX_ELECTRIC_SHAPE_URL:"http://127.0.0.1:52581/v1/shape"};expect(inboxSyncUpstream(local).upstreamHeaders).toBeUndefined();expect(()=>inboxSyncUpstream({...local,NODE_ENV:"production"})).toThrow();expect(()=>inboxSyncUpstream({...local,INBOX_ELECTRIC_SHAPE_URL:"http://private.example:3000/v1/shape"})).toThrow();});
 it("does not permit an unknown configuration mode",()=>expect(()=>inboxSyncUpstream({...env,INBOX_ELECTRIC_UPSTREAM_MODE:"automatic"})).toThrow());
});
