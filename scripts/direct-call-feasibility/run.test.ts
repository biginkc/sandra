 
import { describe, expect, it } from "vitest";
import { childEnv, parseArgs } from "./run";

describe("run cli", () => {
  it("strips the API key and 1Password token from child env", () => {
    const e = childEnv({ TELNYX_API_KEY: "a", OP_SERVICE_ACCOUNT_TOKEN: "b", PATH: "/bin" });
    expect(e).toEqual({ PATH: "/bin" });
  });
  it("is dry-run unless --live is passed", () => {
    expect(parseArgs(["f1"]).live).toBe(false);
    expect(parseArgs(["f1", "--live"])).toEqual({ cmd: "f1", live: true });
  });
});
