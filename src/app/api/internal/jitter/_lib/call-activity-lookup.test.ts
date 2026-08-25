import { describe, expect, it } from "vitest";

import { callActivityAttemptProviderFilter } from "./call-activity-lookup";

describe("call activity attempt provider filter", () => {
  it("matches a Jitter row only in the requested session", () => {
    expect(callActivityAttemptProviderFilter("scope-default")).toBe(
      'and(provider.eq.jitter,jitter_session_id.eq."scope-default"),and(provider.eq.sandra_softphone,jitter_session_id.is.null),and(provider.eq.sandra_softphone,jitter_session_id.eq."scope-default")',
    );
  });

  it("matches a softphone row with no session or the requested session", () => {
    const filter = callActivityAttemptProviderFilter("scope-default");

    expect(filter).toContain(
      "and(provider.eq.sandra_softphone,jitter_session_id.is.null)",
    );
    expect(filter).toContain(
      'and(provider.eq.sandra_softphone,jitter_session_id.eq."scope-default")',
    );
  });

  it("quotes PostgREST-reserved scope characters", () => {
    expect(callActivityAttemptProviderFilter('scope,with)quotes\\')).toContain(
      'jitter_session_id.eq."scope,with)quotes\\\\"',
    );
  });
});
