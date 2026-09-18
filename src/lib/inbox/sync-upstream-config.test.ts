import {describe,expect,it} from "vitest";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {inboxSyncUpstream} from "./sync-upstream-config";
const env={NODE_ENV:"production",INBOX_ELECTRIC_SHAPE_URL:"https://relay.example/v1/shape",INBOX_ELECTRIC_PROJECTION_TABLE:"inbox_bridge.summaries",INBOX_ELECTRIC_RELAY_TOKEN:"a".repeat(64)} as NodeJS.ProcessEnv;
// Shared with services/inbox-sync-relay/server.test.mjs (G4 / #592): both suites must agree on which
// tokens are accepted. Do not fork this file; edit deployment/inbox/relay-token-fixtures.json instead.
const fixturePath=fileURLToPath(new URL("../../../deployment/inbox/relay-token-fixtures.json",import.meta.url));
const tokenFixtures=JSON.parse(readFileSync(fixturePath,"utf8")) as {valid:string[];invalid:string[]};
describe("private sync relay configuration",()=>{
 it("adds a server-only Bearer header without putting the token in the URL",()=>{const config=inboxSyncUpstream(env);expect(config.upstreamHeaders).toEqual({authorization:`Bearer ${env.INBOX_ELECTRIC_RELAY_TOKEN}`});expect(config.electricUrl).not.toContain(env.INBOX_ELECTRIC_RELAY_TOKEN!);});
 it.each([undefined,"short","a".repeat(257),"bad\nheader"+"a".repeat(32)])("fails closed for invalid token %s",token=>expect(()=>inboxSyncUpstream({...env,INBOX_ELECTRIC_RELAY_TOKEN:token})).toThrow());
 it.each(["http://relay.example/v1/shape","https://user:pass@relay.example/v1/shape","https://relay.example/v1/shape?token=secret","https://relay.example/other"])("rejects unsafe relay endpoint %s",url=>expect(()=>inboxSyncUpstream({...env,INBOX_ELECTRIC_SHAPE_URL:url})).toThrow());
 it("requires an explicit dev/test loopback profile and never sends a relay secret there",()=>{const local: NodeJS.ProcessEnv={...env,NODE_ENV:"development",INBOX_ELECTRIC_UPSTREAM_MODE:"owned-local",INBOX_ELECTRIC_SHAPE_URL:"http://127.0.0.1:52581/v1/shape"};expect(inboxSyncUpstream(local).upstreamHeaders).toBeUndefined();expect(()=>inboxSyncUpstream({...local,NODE_ENV:"production"})).toThrow();expect(()=>inboxSyncUpstream({...local,INBOX_ELECTRIC_SHAPE_URL:"http://private.example:3000/v1/shape"})).toThrow();});
 it("supports the marked development relay with a server-only bearer token",()=>{const local: NodeJS.ProcessEnv={...env,NODE_ENV:"development",INBOX_ELECTRIC_UPSTREAM_MODE:"owned-relay",INBOX_ELECTRIC_SHAPE_URL:"http://127.0.0.1:52581/v1/shape"};expect(inboxSyncUpstream(local).upstreamHeaders).toEqual({authorization:`Bearer ${env.INBOX_ELECTRIC_RELAY_TOKEN}`});expect(()=>inboxSyncUpstream({...local,NODE_ENV:"production"})).toThrow();expect(()=>inboxSyncUpstream({...local,INBOX_ELECTRIC_RELAY_TOKEN:"short"})).toThrow();expect(()=>inboxSyncUpstream({...local,INBOX_ELECTRIC_SHAPE_URL:"http://private.example:3000/v1/shape"})).toThrow();});
 it("does not permit an unknown configuration mode",()=>expect(()=>inboxSyncUpstream({...env,INBOX_ELECTRIC_UPSTREAM_MODE:"automatic"})).toThrow());
});
describe("relay token parity fixture (G4 / #592)",()=>{
 it.each(tokenFixtures.valid)("accepts fixture-valid token %s",token=>{
  const config=inboxSyncUpstream({...env,INBOX_ELECTRIC_RELAY_TOKEN:token});
  expect(config.upstreamHeaders).toEqual({authorization:`Bearer ${token}`});
 });
 it.each(tokenFixtures.invalid)("rejects fixture-invalid token %s",token=>{
  expect(()=>inboxSyncUpstream({...env,INBOX_ELECTRIC_RELAY_TOKEN:token})).toThrow();
 });
});
