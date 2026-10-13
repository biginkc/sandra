import { describe, expect, it } from "vitest";

import { readNormaQueueConfig } from "./config";
import { shouldSendNormaPrecallSms } from "./precall-policy";

// PROPOSED (RED): `readNormaQueueConfig(env)` returns { enabled, maxConcurrent, dailyCap, capTz, problems }.
// Invalid input fails closed: enabled=false and `problems` non-empty. Reading is lazy (env passed in), like readNormaGateConfig.
const VALID = { NORMA_QUEUE_ENABLED: "true", NORMA_QUEUE_MAX_CONCURRENT: "5", NORMA_QUEUE_DAILY_CAP: "200", NORMA_QUEUE_CAP_TZ: "America/New_York" };

describe("readNormaQueueConfig", () => {
  it("is OFF when NORMA_QUEUE_ENABLED is unset", () => {
    expect(readNormaQueueConfig({}).enabled).toBe(false);
  });

  it.each(["true", "1", "yes", "on", " TRUE "])("treats %j as on (same flag grammar as the other Norma flags)", (value) => {
    expect(readNormaQueueConfig({ ...VALID, NORMA_QUEUE_ENABLED: value }).enabled).toBe(true);
  });

  it.each(["false", "0", "off", "no", "", "maybe"])("treats %j as off", (value) => {
    expect(readNormaQueueConfig({ ...VALID, NORMA_QUEUE_ENABLED: value }).enabled).toBe(false);
  });

  it("parses valid limits and zone", () => {
    expect(readNormaQueueConfig(VALID)).toMatchObject({ enabled: true, maxConcurrent: 5, dailyCap: 200, capTz: "America/New_York" });
  });

  it("defaults NORMA_QUEUE_CAP_TZ to America/Chicago", () => {
    const { NORMA_QUEUE_CAP_TZ: _omit, ...env } = VALID;
    expect(readNormaQueueConfig(env)).toMatchObject({ enabled: true, capTz: "America/Chicago" });
    expect(readNormaQueueConfig({ ...VALID, NORMA_QUEUE_CAP_TZ: "  " }).capTz).toBe("America/Chicago");
  });

  it.each(["abc", "0", "-1", "1.5", "1e3", "0x10", "+5", " "])("fails closed on invalid NORMA_QUEUE_MAX_CONCURRENT %j", (value) => {
    const config = readNormaQueueConfig({ ...VALID, NORMA_QUEUE_MAX_CONCURRENT: value });
    expect(config.enabled).toBe(false);
    expect(config.problems.length).toBeGreaterThan(0);
  });

  it.each(["abc", "0", "-1", "2.5", "1e3"])("fails closed on invalid NORMA_QUEUE_DAILY_CAP %j", (value) => {
    const config = readNormaQueueConfig({ ...VALID, NORMA_QUEUE_DAILY_CAP: value });
    expect(config.enabled).toBe(false);
    expect(config.problems.length).toBeGreaterThan(0);
  });

  it.each(["Mars/Phobos", "CST", "America/Chicag0", "not a zone"])("fails closed on an unknown NORMA_QUEUE_CAP_TZ %j", (value) => {
    const config = readNormaQueueConfig({ ...VALID, NORMA_QUEUE_CAP_TZ: value });
    expect(config.enabled).toBe(false);
    expect(config.problems.length).toBeGreaterThan(0);
  });

  it("a valid config has no problems", () => {
    expect(readNormaQueueConfig(VALID).problems).toEqual([]);
  });

  it("never throws on a hostile environment", () => {
    expect(() => readNormaQueueConfig({ NORMA_QUEUE_ENABLED: "true", NORMA_QUEUE_MAX_CONCURRENT: "\u0000", NORMA_QUEUE_DAILY_CAP: "9".repeat(400) })).not.toThrow();
  });

  it.each([
    ["MAX_CONCURRENT unset", { NORMA_QUEUE_ENABLED: "true", NORMA_QUEUE_DAILY_CAP: "200" }],
    ["DAILY_CAP unset", { NORMA_QUEUE_ENABLED: "true", NORMA_QUEUE_MAX_CONCURRENT: "5" }],
    ["both unset", { NORMA_QUEUE_ENABLED: "true" }],
  ])("fails closed when enabled with %s (no defaults: no dispatch)", (_label, env) => {
    const config = readNormaQueueConfig(env);
    expect(config.enabled).toBe(false);
    expect(config.problems.length).toBeGreaterThan(0);
  });
});

describe("shouldSendNormaPrecallSms (H2)", () => {
  it("queue rows skip the precall SMS by default, even when the feature flag is on", () => {
    expect(shouldSendNormaPrecallSms({ queueEntryId: "e1", attempt: 1, precallEnabled: true })).toBe(false);
  });

  it("button rows keep today's behaviour: attempt 1 texts when enabled", () => {
    expect(shouldSendNormaPrecallSms({ queueEntryId: null, attempt: 1, precallEnabled: true })).toBe(true);
  });

  it("button rows do not text when the feature flag is off, or on attempt 2", () => {
    expect(shouldSendNormaPrecallSms({ queueEntryId: null, attempt: 1, precallEnabled: false })).toBe(false);
    expect(shouldSendNormaPrecallSms({ queueEntryId: null, attempt: 2, precallEnabled: true })).toBe(false);
  });

  it.todo("needs Jarrad: should the queue send a precall text on every attempt (up to 24) or only the first? Build default = queue skips it.");
});
