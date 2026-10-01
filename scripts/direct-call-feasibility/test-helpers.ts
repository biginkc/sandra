 
import { loadConfig, type Config } from "./env";
import { Inventory } from "./inventory";

export const SECRET = "KEYTESTSECRET0123456789ABCDEF";
export const PHONE = "+15555550101";
export const CALLER = "+15555550199";

export function cfg(over: Record<string, string> = {}): Config {
  return loadConfig({
    TELNYX_API_KEY: SECRET,
    DIRECT_CALL_TEST_PHONES: PHONE,
    DIRECT_CALL_CALLER_ID: CALLER,
    DIRECT_CALL_PUBLIC_BASE_URL: "https://example.trycloudflare.com",
    TELNYX_PUBLIC_KEY: "x",
    DIRECT_CALL_DEV_SIP_ENDPOINTS: "sip:dev@example.test",
    ...over,
  });
}

export function inventory(): Inventory {
  const inv = new Inventory();
  inv.add("call_control_application", "app1");
  inv.setRole("appId", "app1");
  inv.add("credential_connection", "conn1");
  inv.setRole("connectionId", "conn1");
  inv.add("telephony_credential", "cred1");
  inv.addSipUsername("gencreduser1");
  inv.add("call_leg", "leg1");
  return inv;
}

export function jsonRes(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}
