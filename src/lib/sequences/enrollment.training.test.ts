import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
vi.mock("@/lib/leads/training", () => ({ assertNotTrainingTarget: vi.fn().mockRejectedValue(new Error("Internal training")) }));
import { enrollLead, resumeByProperty } from "./enrollment";

describe("training enrollment boundaries", () => {
  it("does not read a sequence or create enrollment for training", async () => {
    const from = vi.fn();
    const client = { from } as unknown as SupabaseClient<Database>;
    await expect(enrollLead(client, { sequenceId: "sequence", propertyId: "training" })).rejects.toThrow("Internal training");
    expect(from).not.toHaveBeenCalled();
  });
  it("does not resume training enrollment after call completion", async () => {
    const from = vi.fn();
    const client = { from } as unknown as SupabaseClient<Database>;
    await expect(resumeByProperty(client, { propertyId: "training" })).rejects.toThrow("Internal training");
    expect(from).not.toHaveBeenCalled();
  });
});
