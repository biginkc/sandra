import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/types";
import { loadTemplateVars } from "@/lib/sequences/template-vars";
import { renderTemplate } from "@/lib/templates/render";

import { getOutboundSenderName } from "./sender-persona";

function createTemplateVarClient() {
  const getUserById = vi.fn(async () => ({
    data: { user: { email: "jarrad@example.com" } },
  }));

  const rows: Record<string, unknown> = {
    properties: {
      address: "123 Main St",
      city: "Kansas City",
      state: "MO",
      zip: "64101",
      market: "KC",
      org_id: "org-1",
    },
    contacts: {
      first_name: "Andrew",
      last_name: "Seller",
    },
    organizations: {
      name: "BMH",
    },
  };

  const client = {
    auth: {
      admin: { getUserById },
    },
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: rows[table] ?? null,
            error: null,
          }),
        }),
      }),
    }),
  } as unknown as SupabaseClient<Database>;

  return { client, getUserById };
}

describe("outbound sender persona", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to Mel when no env override is configured", () => {
    vi.stubEnv("OUTBOUND_SENDER_NAME", "");

    expect(getOutboundSenderName()).toBe("Mel");
  });

  it("uses a trimmed env override", () => {
    vi.stubEnv("OUTBOUND_SENDER_NAME", "  Rosa  ");

    expect(getOutboundSenderName()).toBe("Rosa");
  });

  it("renders {{my_first_name}} as Mel regardless of the sending user email", async () => {
    vi.stubEnv("OUTBOUND_SENDER_NAME", "");
    const { client, getUserById } = createTemplateVarClient();

    const vars = await loadTemplateVars(client, {
      propertyId: "property-1",
      contactId: "contact-1",
    });

    expect(vars.first_name).toBe("Andrew");
    expect(vars.my_first_name).toBe("Mel");
    expect(getUserById).not.toHaveBeenCalled();
    expect(
      renderTemplate("Hi {{first_name}}, {{my_first_name}} here.", vars),
    ).toBe("Hi Andrew, Mel here.");
  });

  it("renders {{my_first_name}} from OUTBOUND_SENDER_NAME when overridden", async () => {
    vi.stubEnv("OUTBOUND_SENDER_NAME", "  Rosa  ");
    const { client } = createTemplateVarClient();

    const vars = await loadTemplateVars(client, {
      propertyId: "property-1",
      contactId: "contact-1",
    });

    expect(
      renderTemplate("Hi {{first_name}}, {{my_first_name}} here.", vars),
    ).toBe("Hi Andrew, Rosa here.");
  });
});
