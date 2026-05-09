import { describe, expect, it } from "vitest";

import { signOAuthState, verifyOAuthState } from "./state";

describe("slack/state", () => {
  it("signOAuthState produces userId.timestamp.hmac", () => {
    const state = signOAuthState({
      userId: "user-1",
      secret: "state-secret",
      now: 1760000000,
    });

    expect(state).toMatch(/^user-1\.1760000000\.[a-f0-9]{64}$/);
  });

  it("verifyOAuthState accepts a valid current state", () => {
    const state = signOAuthState({
      userId: "user-1",
      secret: "state-secret",
      now: 1760000000,
    });

    expect(
      verifyOAuthState({
        state,
        secret: "state-secret",
        expectedUserId: "user-1",
        now: 1760000010,
      }),
    ).toBe(true);
  });

  it("verifyOAuthState rejects mismatched users", () => {
    const state = signOAuthState({
      userId: "user-1",
      secret: "state-secret",
      now: 1760000000,
    });

    expect(
      verifyOAuthState({
        state,
        secret: "state-secret",
        expectedUserId: "user-2",
        now: 1760000000,
      }),
    ).toBe(false);
  });

  it("verifyOAuthState rejects malformed states", () => {
    expect(
      verifyOAuthState({
        state: "wrong.parts",
        secret: "state-secret",
        expectedUserId: "user-1",
        now: 1760000000,
      }),
    ).toBe(false);
    expect(
      verifyOAuthState({
        state: "user-1.not-a-number.deadbeef",
        secret: "state-secret",
        expectedUserId: "user-1",
        now: 1760000000,
      }),
    ).toBe(false);
  });

  it("verifyOAuthState rejects expired and far-future states", () => {
    const expired = signOAuthState({
      userId: "user-1",
      secret: "state-secret",
      now: 1760000000,
    });
    const future = signOAuthState({
      userId: "user-1",
      secret: "state-secret",
      now: 1760000101,
    });

    expect(
      verifyOAuthState({
        state: expired,
        secret: "state-secret",
        expectedUserId: "user-1",
        now: 1760000601,
      }),
    ).toBe(false);
    expect(
      verifyOAuthState({
        state: future,
        secret: "state-secret",
        expectedUserId: "user-1",
        now: 1760000000,
      }),
    ).toBe(false);
  });

  it("verifyOAuthState rejects tampered HMAC values", () => {
    const state = signOAuthState({
      userId: "user-1",
      secret: "state-secret",
      now: 1760000000,
    });
    const replacement = state.endsWith("0") ? "1" : "0";
    const tampered = `${state.slice(0, -1)}${replacement}`;

    expect(
      verifyOAuthState({
        state: tampered,
        secret: "state-secret",
        expectedUserId: "user-1",
        now: 1760000000,
      }),
    ).toBe(false);
  });
});
