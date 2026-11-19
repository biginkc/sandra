import { describe, expect, it } from "vitest";

import { runHoldAlertsForOrg } from "./core";
import { hotPromotionSlackHeadline, hotPromotionSlackText, hotPromotionSmsText, slackFirstHeadline, smsText } from "./messages";
import { buildSlackAlertBlocks, formatThreadTime, toThread, type SlackBlock, type ThreadMessage } from "./slack-thread";
import { hold, makeDeps, ORG } from "./test-support";
import type { HotPromotion } from "./types";

// Synthetic text only: never real seller messages.
const URL_ = "https://app.example.com";
const NOW = Date.parse("2026-11-18T20:00:00.000Z"); // 2:00 pm Chicago
const promo: HotPromotion = {
  propertyId: "p1",
  assigneeUserId: "u1",
  name: "Pat",
  assignedAt: "2026-11-18T19:00:00Z",
  kind: "hot_text",
  key: "hot_text:in-1",
  inboundId: "in-1",
  address: "123 Example St",
};
const msg = (direction: ThreadMessage["direction"], body: string, createdAt: string): ThreadMessage => ({ direction, body, createdAt });
const sections = (blocks: SlackBlock[]) => blocks[0].elements as SlackBlock[];
const lineText = (s: SlackBlock) => (s.elements as SlackBlock[]).filter((e) => e.type === "text").map((e) => e.text).join("");

describe("Slack headline", () => {
  it("hot_text links 'name, address', keeps the words, drops the URL line", () => {
    const h = hotPromotionSlackHeadline(promo, URL_);
    expect(h).toEqual({ before: "Hot text on your lead: ", linkText: "Pat, 123 Example St", after: ".", url: `${URL_}/leads/p1` });
    const head = sections(buildSlackAlertBlocks(h, [], NOW))[0].elements as SlackBlock[];
    expect(head).toEqual([
      { type: "text", text: "Hot text on your lead: " },
      { type: "link", url: `${URL_}/leads/p1`, text: "Pat, 123 Example St" },
      { type: "text", text: "." },
    ]);
  });

  it("headline words match today's Slack text minus the trailing URL, for every kind", () => {
    const kinds: HotPromotion[] = [
      promo,
      { ...promo, address: null },
      { ...promo, kind: "lead_reply" },
      { ...promo, kind: "handoff" },
      { ...promo, kind: "hot_failed", reason: "hot_lead" },
      { ...promo, kind: "routing_v2_alert", label: "call request" },
      { ...promo, kind: "selling_opportunity" },
      { ...promo, kind: "ambiguous_thread", propertyId: null, linkPath: "/messages?thread=c1" },
    ];
    for (const p of kinds) {
      const h = hotPromotionSlackHeadline(p, URL_);
      // Words only: the ambiguous_thread plain text links /leads (no property); its headline uses the thread link.
      expect(`${h.before}${h.linkText}${h.after}`).toBe(hotPromotionSlackText(p, URL_).replace(/&amp;/g, "&").replace(/ https:\/\/\S+$/, ""));
    }
    expect(hotPromotionSlackHeadline(kinds[7], URL_).url).toBe(`${URL_}/messages?thread=c1`);
  });

  it("hold headline links the name", () => {
    const h = slackFirstHeadline(hold(), URL_);
    expect(h.before).toBe("New hold needs review: ");
    expect(h.linkText).toBe(hold().name);
    expect(h.url).toBe(`${URL_}/leads/${hold().propertyId}`);
  });
});

describe("thread lines", () => {
  const thread = [
    msg("outbound", "Hi there, synthetic opener.", "2026-11-18T18:52:00.000Z"),
    msg("inbound", "What is   your\noffer?", "2026-11-18T19:44:00.000Z"),
  ];

  it("US lines get a blue swatch, SELLER lines do not; oldest first; Chicago time", () => {
    const [, us, seller] = sections(buildSlackAlertBlocks(hotPromotionSlackHeadline(promo, URL_), thread, NOW));
    expect((us.elements as SlackBlock[])[0]).toEqual({ type: "color", value: "#1264A3" });
    expect(lineText(us)).toBe(" US 12:52 pm: Hi there, synthetic opener.\n");
    expect((seller.elements as SlackBlock[]).some((e) => e.type === "color")).toBe(false);
    expect(lineText(seller)).toBe("SELLER 1:44 pm: What is your offer?");
  });

  it("prefixes the date when not today in Chicago", () => {
    expect(formatThreadTime("2026-11-13T02:44:00.000Z", NOW)).toBe("Nov 12 8:44 pm");
    expect(formatThreadTime("2026-11-18T14:05:00.000Z", NOW)).toBe("8:05 am");
  });

  it("truncates bodies over 500 chars", () => {
    const [, line] = sections(buildSlackAlertBlocks(hotPromotionSlackHeadline(promo, URL_), [msg("inbound", "x".repeat(600), "2026-11-18T19:00:00Z")], NOW));
    expect(lineText(line)).toBe(`SELLER 1:00 pm: ${"x".repeat(500)}…`);
  });

  it("toThread caps at the last 10, oldest first, drops unsent outbound", () => {
    const rows = Array.from({ length: 14 }, (_, i) => ({
      direction: i % 2 ? "inbound" : "outbound",
      body: `m${i}`,
      created_at: new Date(NOW - (14 - i) * 60_000).toISOString(),
      status: i === 13 ? null : "sent",
    }));
    rows.push({ direction: "outbound", body: "queued later", created_at: new Date(NOW - 1000).toISOString(), status: "queued" });
    const out = toThread(rows, NOW);
    expect(out.map((m) => m.body)).toEqual(["m4", "m5", "m6", "m7", "m8", "m9", "m10", "m11", "m12", "m13"]);
  });

  it("empty thread → just the linked headline", () => {
    const blocks = buildSlackAlertBlocks(hotPromotionSlackHeadline(promo, URL_), [], NOW);
    expect(blocks).toHaveLength(1);
    expect(sections(blocks)).toHaveLength(1);
  });
});

describe("core wiring", () => {
  it("Slack gets text unchanged + blocks with the thread; SMS text unchanged", async () => {
    const calls: { text: string; blocks?: SlackBlock[] }[] = [];
    const { deps, sent } = makeDeps({
      promotions: [promo],
      holds: [],
      nowIso: "2026-11-18T20:00:00.000Z",
      loadSlackThread: async (_org, lookup) => (lookup.inboundId === "in-1" ? [msg("inbound", "synthetic reply", "2026-11-18T19:30:00Z")] : []),
    });
    const sendSlack = deps.sendSlack;
    deps.sendSlack = async (u, text, blocks) => {
      calls.push({ text, blocks });
      return sendSlack(u, text);
    };
    await runHoldAlertsForOrg(deps, ORG);
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toBe(hotPromotionSlackText(promo, URL_));
    expect(lineText(sections(calls[0].blocks!)[1])).toContain("SELLER 1:30 pm: synthetic reply");
    const sms = sent.find((s) => s.channel === "sms");
    expect(sms?.text).toBe(hotPromotionSmsText(promo, URL_));
    expect(sms?.text).not.toContain("synthetic reply");
  });

  it("a thread lookup error still sends (headline-only blocks)", async () => {
    let blocks: SlackBlock[] | undefined;
    const { deps, sent } = makeDeps({
      promotions: [promo],
      holds: [],
      nowIso: "2026-11-18T20:00:00.000Z",
      loadSlackThread: async () => {
        throw new Error("db down");
      },
    });
    const sendSlack = deps.sendSlack;
    deps.sendSlack = async (u, text, b) => {
      blocks = b;
      return sendSlack(u, text);
    };
    await runHoldAlertsForOrg(deps, ORG);
    expect(sent.filter((s) => s.channel === "slack")).toHaveLength(1);
    expect(sections(blocks!)).toHaveLength(1);
  });

  it("hold SMS copy carries no thread", () => {
    expect(smsText(hold(), URL_)).not.toMatch(/SELLER|US \d/);
  });
});
