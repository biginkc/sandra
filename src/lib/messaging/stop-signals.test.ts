import { describe, expect, it } from "vitest";

import { isCarrierStopKeyword } from "./stop-signals";

describe("isCarrierStopKeyword", () => {
  it.each([
    "STOP",
    "stop",
    "  sToP  ",
    "STOPALL",
    "UNSUBSCRIBE",
    "CANCEL",
    "END",
    "QUIT",
    // Real bodies from the 2026-10-28 missed opt-outs (Sendillo).
    "STOP!!!!",
    "Stop!!!!!!!",
    "STOP.",
    "Stop!",
    "STOP\n",
    "​STOP",
    "STOP​",
    "﻿Stop",
    "STOP ",
    "⁠unsubscribe.",
    "'STOP'",
  ])("treats %j as a bare carrier keyword", (body) => {
    expect(isCarrierStopKeyword(body)).toBe(true);
  });

  it.each([
    // REMOVE / OPT OUT are not carrier keywords in Sandra: they are held for a
    // person (Jarrad 2026-10-08, .planning/messages-v2/PLAN.md).
    "REMOVE",
    "remove",
    "OPTOUT ",
    "opt out",
    "stop by",
    "STOP texting me",
    "please stop",
    "S.T.O.P",
    "stopped",
    "",
    "!!!!",
  ])("does not treat %j as a bare carrier keyword", (body) => {
    expect(isCarrierStopKeyword(body)).toBe(false);
  });
});
