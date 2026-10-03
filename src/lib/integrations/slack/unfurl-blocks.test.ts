import { describe, expect, it } from "vitest";

import { buildPreviewBlocks, canonicalPreviewUrl } from "./unfurl-blocks";
import type { SlackLeadPreview } from "./unfurl-types";

const PROPERTY = "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF";

function preview(overrides: Partial<SlackLeadPreview> = {}): SlackLeadPreview {
  return {
    propertyId: PROPERTY.toLowerCase(),
    leadName: "Jane Seller",
    address: "123 Main St, Kansas City, MO",
    ownerName: "Owner Name",
    ownerAssigned: true,
    latestAttempt: {
      id: "11111111-1111-4111-8111-111111111111",
      occurredAt: "2026-10-03T12:00:00.000Z",
      outcome: "no_answer",
    },
    messagesDisposition: "not_interested",
    lastContactAt: "2026-10-03T12:00:00.000Z",
    timezone: "America/Chicago",
    messages: [],
    ...overrides,
  };
}

function blockText(block: unknown): string {
  const value = block as { text?: { text?: string }; fields?: Array<{ text?: string }> };
  return [value.text?.text, ...(value.fields?.map((field) => field.text ?? []) ?? [])]
    .filter((text): text is string => Boolean(text))
    .join(" ");
}

describe("buildPreviewBlocks", () => {
  it("renders the agreed header, compact facts, one arrow strip, and canonical CTA", () => {
    const blocks = buildPreviewBlocks(preview({
      messages: [
        { id: "1", createdAt: "2026-10-03T10:00:00Z", body: "Hello", direction: "outbound", deliveryStatus: "sent", attachmentCount: 0 },
        { id: "2", createdAt: "2026-10-03T11:00:00Z", body: "Hi there", direction: "inbound", deliveryStatus: "received", attachmentCount: 0 },
        { id: "3", createdAt: "2026-10-03T12:00:00Z", body: "Photo", direction: "outbound", deliveryStatus: "failed", attachmentCount: 0 },
      ],
    }));

    expect(blocks).toHaveLength(4);
    expect(blocks[0]).toMatchObject({
      type: "header",
      text: { type: "plain_text", text: "Lead preview: Jane Seller" },
    });
    expect(blocks[1]).toMatchObject({ type: "section", fields: expect.any(Array) });
    expect((blocks[1] as { fields: Array<{ text: string }> }).fields.map((field) => field.text)).toEqual([
      "Lead\nJane Seller",
      "Address\n123 Main St, Kansas City, MO",
      "Owner\nOwner Name",
      "My Leads attempt\nNo Answer",
      "Messages disposition\nnot_interested",
      "Last contact\nOct 3, 2026, 7:00 AM CDT",
    ]);
    expect(blocks[2]).toMatchObject({
      type: "section",
      text: { type: "plain_text", text: "Us: Hello → Them: Hi there → Us: Photo · Not delivered" },
    });
    expect(blocks[3]).toMatchObject({
      type: "actions",
      elements: [{
        type: "button",
        action_id: "open_my_leads",
        text: { type: "plain_text", text: "Open in My Leads" },
        url: "https://sandra.bmhgroupkc.com/my-leads?lead=abcdefab-cdef-4abc-8def-abcdefabcdef",
      }],
    });
  });

  it("uses plain_text for all user-controlled preview content and does not enable parsing", () => {
    const blocks = buildPreviewBlocks(preview({
      leadName: "<@U123> *Seller* https://evil.example",
      address: "<https://evil.example|Click> @channel",
      ownerName: "<b>Owner</b>",
      messagesDisposition: "*not_interested* <@everyone>",
      messages: [{
        id: "1",
        createdAt: "2026-10-03T10:00:00Z",
        body: "<https://evil.example|bad> *markup* @here",
        direction: "inbound",
        deliveryStatus: "received",
        attachmentCount: 0,
      }],
    }));

    expect(blocks.every((block) => !blockText(block).includes("mrkdwn"))).toBe(true);
    expect(blocks.filter((block) => block.type === "header" || block.type === "section")
      .flatMap((block) => {
        const candidate = block as { text?: { type?: string }; fields?: Array<{ type?: string }> };
        return [candidate.text?.type, ...(candidate.fields?.map((field) => field.type) ?? [])];
      })
      .filter(Boolean)
      .every((type) => type === "plain_text")).toBe(true);
    expect(blockText(blocks[1])).toContain("<@U123>");
    expect(blockText(blocks[2])).toContain("<https://evil.example|bad>");
  });

  it("preserves Unicode code points, truncates excerpts to 64, and labels attachments/failures", () => {
    const blocks = buildPreviewBlocks(preview({
      messages: [
        { id: "1", createdAt: "2026-10-03T10:00:00Z", body: "", direction: "inbound", deliveryStatus: "received", attachmentCount: 2 },
        { id: "2", createdAt: "2026-10-03T11:00:00Z", body: "", direction: "outbound", deliveryStatus: "failed", attachmentCount: 0 },
        { id: "3", createdAt: "2026-10-03T12:00:00Z", body: "😀".repeat(80), direction: "inbound", deliveryStatus: "received", attachmentCount: 0 },
      ],
    }));

    const text = (blocks[2] as { text: { text: string } }).text.text;
    expect(text).toContain("Them: 2 attachments");
    expect(text).toContain("Us: No text content · Not delivered");
    const emojiLine = text.split(" → ")[2]!;
    expect(Array.from(emojiLine.replace("Them: ", "")).length).toBe(64);
    expect(emojiLine.endsWith("…")).toBe(true);
  });

  it("renders truthful missing values and no texts without inventing status", () => {
    const blocks = buildPreviewBlocks(preview({
      leadName: null,
      address: null,
      ownerName: null,
      ownerAssigned: false,
      latestAttempt: null,
      messagesDisposition: null,
      lastContactAt: null,
      messages: [],
    }));

    expect(blocks[1]).toMatchObject({
      fields: expect.arrayContaining([
        { type: "plain_text", text: "Lead\nName unavailable", emoji: true },
        { type: "plain_text", text: "Address\nAddress unavailable", emoji: true },
        { type: "plain_text", text: "Owner\nUnassigned", emoji: true },
        { type: "plain_text", text: "My Leads attempt\nNo attempt outcome recorded", emoji: true },
        { type: "plain_text", text: "Messages disposition\nNo disposition recorded", emoji: true },
        { type: "plain_text", text: "Last contact\nNo successful contact recorded", emoji: true },
      ]),
    });
    expect(blocks[2]).toMatchObject({ text: { type: "plain_text", text: "No texts yet" } });
  });

  it("bounds every Slack text/url field and renders at most three texts", () => {
    const oversized = "x".repeat(5000);
    const blocks = buildPreviewBlocks(preview({
      leadName: oversized,
      address: oversized,
      ownerName: oversized,
      messagesDisposition: oversized,
      messages: Array.from({ length: 5 }, (_, index) => ({
        id: String(index),
        createdAt: "2026-10-03T10:00:00Z",
        body: oversized,
        direction: "inbound" as const,
        deliveryStatus: "received",
        attachmentCount: 0,
      })),
    }));

    const header = blocks[0] as { text: { text: string } };
    const fields = (blocks[1] as { fields: Array<{ text: string }> }).fields;
    const strip = blocks[2] as { text: { text: string } };
    const button = (blocks[3] as { elements: Array<{ text: { text: string }; url: string }> }).elements[0]!;
    expect(Array.from(header.text.text).length).toBeLessThanOrEqual(150);
    expect(fields.every((field) => Array.from(field.text).length <= 2000)).toBe(true);
    expect(Array.from(strip.text.text).length).toBeLessThanOrEqual(3000);
    expect(Array.from(button.text.text).length).toBeLessThanOrEqual(75);
    expect(Array.from(button.url).length).toBeLessThanOrEqual(3000);
    expect(strip.text.text.match(/Them:/g)).toHaveLength(3);
  });
});

describe("canonicalPreviewUrl", () => {
  it("uses the exact lowercase canonical My Leads target", () => {
    expect(canonicalPreviewUrl(PROPERTY)).toBe(
      "https://sandra.bmhgroupkc.com/my-leads?lead=abcdefab-cdef-4abc-8def-abcdefabcdef",
    );
  });
});
