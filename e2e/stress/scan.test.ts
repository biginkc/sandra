import { appendFileSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { scanServerLog } from "./engine";

const log = (lines: string[]) => {
  const f = path.join(mkdtempSync(path.join(os.tmpdir(), "scan-")), "app.log");
  writeFileSync(f, lines.join("\n") + "\n");
  return f;
};
const FETCH = "[browser] ⨯ unhandledRejection: TypeError: Failed to fetch";

describe("server log scan", () => {
  it("flags 5xx and unhandled rejections", () => {
    expect(scanServerLog(log([" GET /x 500 in 12ms", "⨯ unhandledRejection: Error: boom", " GET /y 200 in 3ms"]), 0)).toHaveLength(2);
  });
  it("tolerates exactly as many offline-gesture fetch failures as gestures ran, never more", () => {
    const f = log([FETCH, FETCH]);
    expect(scanServerLog(f, 0, { injectedOfflineFetchFailures: 2 })).toEqual([]);
    expect(scanServerLog(f, 0, { injectedOfflineFetchFailures: 1 })).toHaveLength(1);
    expect(scanServerLog(f, 0)).toHaveLength(2);
  });
  it("does not tolerate any other rejection, even when a fetch failure is allowed", () => {
    expect(scanServerLog(log([FETCH, "⨯ unhandledRejection: TypeError: other"]), 0, { injectedOfflineFetchFailures: 1 })).toHaveLength(1);
  });
  it("a byte offset past multibyte text still starts at the right byte", () => {
    const f = log(["Zoë ✓ 日本語 ñandú 🚫"]);
    const off = statSync(f).size;
    appendFileSync(f, " GET /z 500 in 9ms\n");
    expect(scanServerLog(f, off)).toHaveLength(1);
  });
});
