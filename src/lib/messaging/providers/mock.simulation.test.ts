import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearPendingMockReplies,
  getMockMessageLog,
  getPendingMockReplies,
  MockMessagingProvider,
  registerMockPersona,
  resetMockState,
} from "./mock";

const provider = new MockMessagingProvider();
const OUR_NUMBER = "+15551234567";

describe("MockMessagingProvider — simulation surface", () => {
  beforeEach(() => {
    resetMockState();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --------------------------------------------------------------------------
  // Delivery-state machine (computed from elapsed time since createdAt)
  // --------------------------------------------------------------------------
  describe("delivery state progression", () => {
    it("is 'queued' immediately after send", async () => {
      await provider.sendSms({ to: "+15550001001", body: "hello" });
      expect(getMockMessageLog()[0].state).toBe("queued");
    });

    it("progresses to 'sent' at 500ms, 'delivered' at 1000ms", async () => {
      await provider.sendSms({ to: "+15550001001", body: "hello" });

      vi.advanceTimersByTime(499);
      expect(getMockMessageLog()[0].state).toBe("queued");

      vi.advanceTimersByTime(1); // 500ms elapsed
      expect(getMockMessageLog()[0].state).toBe("sent");

      vi.advanceTimersByTime(500); // 1000ms elapsed
      expect(getMockMessageLog()[0].state).toBe("delivered");

      vi.advanceTimersByTime(60_000);
      expect(getMockMessageLog()[0].state).toBe("delivered");
    });
  });

  // --------------------------------------------------------------------------
  // Error injection via body prefix
  // --------------------------------------------------------------------------
  describe("error injection", () => {
    it("FAIL body still throws (backwards compat)", async () => {
      await expect(
        provider.sendSms({ to: "+15550001001", body: "FAIL" }),
      ).rejects.toThrow(/forced failure/);
      const log = getMockMessageLog();
      expect(log).toHaveLength(1);
      expect(log[0].failReason).toBe("generic");
      expect(log[0].state).toBe("failed");
    });

    it("FAIL-RATE_LIMIT maps to rate_limit reason", async () => {
      await expect(
        provider.sendSms({ to: "+15550001001", body: "FAIL-RATE_LIMIT please" }),
      ).rejects.toThrow(/rate limit/);
      expect(getMockMessageLog()[0].failReason).toBe("rate_limit");
    });

    it("FAIL-CARRIER_BLOCK maps to carrier_block reason", async () => {
      await expect(
        provider.sendSms({ to: "+15550001001", body: "FAIL-CARRIER_BLOCK" }),
      ).rejects.toThrow(/carrier blocked/);
      expect(getMockMessageLog()[0].failReason).toBe("carrier_block");
    });

    it("FAIL-UNKNOWN_NUMBER maps to unknown_number reason", async () => {
      await expect(
        provider.sendSms({ to: "+15550001001", body: "FAIL-UNKNOWN_NUMBER" }),
      ).rejects.toThrow(/unknown recipient/);
      expect(getMockMessageLog()[0].failReason).toBe("unknown_number");
    });

    it("failures are logged (state=failed) and don't schedule persona replies", async () => {
      registerMockPersona("+15550001001", "responder");
      await expect(
        provider.sendSms({ to: "+15550001001", body: "FAIL" }),
      ).rejects.toThrow();
      vi.advanceTimersByTime(60 * 60 * 1000);
      expect(getPendingMockReplies()).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // Personas
  // --------------------------------------------------------------------------
  describe("personas", () => {
    it("responder schedules a positive reply +1h after send", async () => {
      registerMockPersona("+15550002001", "responder");
      await provider.sendSms({ to: "+15550002001", body: "hi" });

      // No replies due yet.
      expect(getPendingMockReplies()).toHaveLength(0);

      // Advance 59m — still nothing.
      vi.advanceTimersByTime(59 * 60 * 1000);
      expect(getPendingMockReplies()).toHaveLength(0);

      // Advance past the 1h mark.
      vi.advanceTimersByTime(2 * 60 * 1000);
      const replies = getPendingMockReplies();
      expect(replies).toHaveLength(1);
      expect(replies[0]).toMatchObject({
        from: "+15550002001",
        to: OUR_NUMBER,
      });
      expect(replies[0].body.toLowerCase()).toContain("interested");
    });

    it("opt_outer schedules STOP near-immediately on first send only", async () => {
      registerMockPersona("+15550002002", "opt_outer");
      await provider.sendSms({ to: "+15550002002", body: "hi" });
      await provider.sendSms({ to: "+15550002002", body: "still there?" });

      vi.advanceTimersByTime(2000);
      const replies = getPendingMockReplies();
      expect(replies).toHaveLength(1);
      expect(replies[0].body).toBe("STOP");
    });

    it("ignorer schedules nothing", async () => {
      registerMockPersona("+15550002003", "ignorer");
      await provider.sendSms({ to: "+15550002003", body: "hello" });
      vi.advanceTimersByTime(7 * 24 * 60 * 60 * 1000);
      expect(getPendingMockReplies()).toHaveLength(0);
    });

    it("complainer schedules a negative reply +15m after send", async () => {
      registerMockPersona("+15550002004", "complainer");
      await provider.sendSms({ to: "+15550002004", body: "hey" });
      vi.advanceTimersByTime(16 * 60 * 1000);
      const replies = getPendingMockReplies();
      expect(replies).toHaveLength(1);
      expect(replies[0].body.toLowerCase()).toMatch(/not interested|stop/);
    });

    it("delayed schedules a positive reply +3d after send", async () => {
      registerMockPersona("+15550002005", "delayed");
      await provider.sendSms({ to: "+15550002005", body: "are you interested?" });

      vi.advanceTimersByTime(2 * 24 * 60 * 60 * 1000); // 2d
      expect(getPendingMockReplies()).toHaveLength(0);

      vi.advanceTimersByTime(2 * 24 * 60 * 60 * 1000); // +2d = 4d total
      const replies = getPendingMockReplies();
      expect(replies).toHaveLength(1);
      expect(replies[0].body.toLowerCase()).toContain("still");
    });

    it("unknown phone (no persona registered) schedules nothing", async () => {
      await provider.sendSms({ to: "+15550002099", body: "hi" });
      vi.advanceTimersByTime(7 * 24 * 60 * 60 * 1000);
      expect(getPendingMockReplies()).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // Log introspection + cleanup
  // --------------------------------------------------------------------------
  describe("log + cleanup", () => {
    it("logs every send with input, createdAt, and externalId", async () => {
      await provider.sendSms({ to: "+15550003001", body: "one" });
      await provider.sendSms({ to: "+15550003002", body: "two" });
      const log = getMockMessageLog();
      expect(log).toHaveLength(2);
      expect(log[0].to).toBe("+15550003001");
      expect(log[0].body).toBe("one");
      expect(log[0].externalId).toMatch(/^mock_/);
      expect(log[1].to).toBe("+15550003002");
      expect(log[1].body).toBe("two");
    });

    it("resetMockState clears log, personas, and pending replies", async () => {
      registerMockPersona("+15550003003", "responder");
      await provider.sendSms({ to: "+15550003003", body: "hi" });
      vi.advanceTimersByTime(60 * 60 * 1000);

      expect(getMockMessageLog()).toHaveLength(1);
      expect(getPendingMockReplies()).toHaveLength(1);

      resetMockState();
      expect(getMockMessageLog()).toHaveLength(0);
      expect(getPendingMockReplies()).toHaveLength(0);
    });

    it("clearPendingMockReplies removes specific ids (or all when omitted)", async () => {
      registerMockPersona("+15550003004", "responder");
      registerMockPersona("+15550003005", "responder");
      await provider.sendSms({ to: "+15550003004", body: "a" });
      await provider.sendSms({ to: "+15550003005", body: "b" });
      vi.advanceTimersByTime(60 * 60 * 1000);

      const before = getPendingMockReplies();
      expect(before).toHaveLength(2);

      clearPendingMockReplies([before[0].id]);
      expect(getPendingMockReplies()).toHaveLength(1);

      clearPendingMockReplies();
      expect(getPendingMockReplies()).toHaveLength(0);
    });
  });
});
