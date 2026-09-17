import { beforeEach, describe, expect, it, vi } from "vitest";

const createClient = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/server", () => ({ createClient }));

import { readRepSmsContext } from "./rep-sms";

const body = "Hey, this is Mel, Maria's assistant.\n\nPlease text Maria a time that works.";

beforeEach(() => {
  vi.resetAllMocks();
});

describe("readRepSmsContext generic SMS recovery", () => {
  it("loads the service-owned submission with its immutable key, sender, recipient, and body", async () => {
    const client = {
      rpc: vi.fn((name: string) => Promise.resolve(
        name === "fn_get_rep_sms_context"
          ? {
              data: {
                orgId: "org-1",
                actorId: "rep-1",
                contactId: "contact-1",
                provider: "sendillo",
                senders: [{
                  id: "sender-1",
                  number: "+18163706846",
                  label: "Mel",
                  isDefault: true,
                  provider: "sendillo",
                  providerAccountId: "account-1",
                  providerSenderId: "provider-sender-1",
                  grantStatus: "active",
                  compositionPolicyVersion: 1,
                }],
                obligation: null,
              },
              error: null,
            }
          : {
              data: {
                draft: {
                  key: "11111111-1111-4111-8111-111111111111",
                  receiptId: "22222222-2222-4222-8222-222222222222",
                  state: "unknown",
                  assignmentId: "sender-1",
                  from: "+18163706846",
                  to: "+18165550123",
                  body,
                  composition: {
                    introId: "mel-maria-assistant-1",
                    introVersion: 1,
                    templateId: "no-answer-callback-time",
                    templateVersion: 1,
                    remainder: "Please text Maria a time that works.",
                  },
                  providerMessageId: null,
                  providerError: "receipt unavailable",
                  createdAt: "2026-09-17T10:00:00.000Z",
                  updatedAt: "2026-09-17T10:00:01.000Z",
                },
              },
              error: null,
            },
      )),
      from: vi.fn(() => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({
              data: {
                phone_1: "+18165550123",
                phone_1_type: "mobile",
                phone_2: null,
                phone_2_type: null,
                phone_3: null,
                phone_3_type: null,
              },
              error: null,
            }),
          }),
        }),
      })),
    };
    createClient.mockResolvedValue(client);

    const context = await readRepSmsContext("property-1");

    expect(context.submission).toEqual(expect.objectContaining({
      key: "11111111-1111-4111-8111-111111111111",
      receiptId: "22222222-2222-4222-8222-222222222222",
      state: "unknown",
      assignmentId: "sender-1",
      from: "+18163706846",
      to: "+18165550123",
      body,
    }));
    expect(context.submission?.composition).toEqual(expect.objectContaining({
      templateId: "no-answer-callback-time",
      remainder: "Please text Maria a time that works.",
    }));
    expect(context.phone).toBe("+18165550123");
  });
});
