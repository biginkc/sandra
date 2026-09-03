import { describe, expect, it } from "vitest";

import {
  authoritativeDisplayName,
  teamMemberFromAuthUser,
  teamMemberOptionLabel,
  teamMemberPrimaryLabel,
  teamMemberSecondaryLabel,
} from "./team-member";

describe("team member presentation", () => {
  it("uses only administrator-controlled identity metadata", () => {
    expect(
      authoritativeDisplayName({
        user_metadata: {
          display_name: "  Alex Rivera  ",
          full_name: "Ignored Name",
        },
      }),
    ).toBeNull();
    expect(
      authoritativeDisplayName({
        app_metadata: { display_name: "Admin Verified" },
        user_metadata: { display_name: "User Editable" },
      }),
    ).toBe("Admin Verified");
    expect(
      authoritativeDisplayName({
        user_metadata: { given_name: "Alex", family_name: "Rivera" },
      }),
    ).toBeNull();
  });

  it("never fabricates a name from an email or exposes an id fragment", () => {
    const member = teamMemberFromAuthUser(
      {
        id: "12345678-1234-1234-1234-123456789abc",
        email: "alex.rivera@example.com",
        user_metadata: {},
      },
      true,
    );

    expect(member.displayName).toBeNull();
    expect(teamMemberOptionLabel(member)).toBe(
      "alex.rivera@example.com — name not set",
    );
    expect(teamMemberOptionLabel(member)).not.toContain("12345678");
    expect(teamMemberSecondaryLabel(member)).toBe("Name not set");
    expect(
      authoritativeDisplayName({
        email: "browser@example.test",
        user_metadata: { display_name: "browser@example.test" },
      }),
    ).toBeNull();
  });

  it("labels the current and former users without changing their ids", () => {
    const member = teamMemberFromAuthUser(
      {
        id: "user-1",
        email: "alex@example.com",
        user_metadata: { full_name: "User Editable" },
        app_metadata: { full_name: "Alex Rivera" },
      },
      false,
    );

    expect(member.id).toBe("user-1");
    expect(teamMemberPrimaryLabel(member, "user-1")).toBe(
      "Alex Rivera (you) (former)",
    );
    expect(teamMemberOptionLabel(member, "user-1")).toBe(
      "Alex Rivera (you) (former) — alex@example.com",
    );
  });
});
