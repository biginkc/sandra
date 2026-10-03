import { reportError } from "@/lib/errors/report";

import { revokeSlackAccountLinks, revokeSlackChannelApproval, revokeSlackInstallation } from "./unfurl-store";

export const SLACK_EVENT_BODY_LIMIT = 256 * 1024;

export type SlackLinkSharedEvent = {
  type: "link_shared";
  channel?: string;
  user?: string;
  message_ts?: string;
  links?: Array<{ url?: string; label?: string }>;
  source?: string;
};

export type SlackEventEnvelope = {
  type: "event_callback";
  team_id?: string;
  api_app_id?: string;
  event_id?: string;
  event_time?: number;
  event?: SlackLinkSharedEvent | { type?: string; channel_id?: string; channel?: string; user_id?: string; user?: string; tokens?: { bot?: string[]; oauth?: string[] } };
};

export type SlackUrlVerification = {
  type: "url_verification";
  challenge?: string;
  team_id?: string;
  api_app_id?: string;
};

export function parseSlackEventsBody(rawBody: string): SlackEventEnvelope | SlackUrlVerification | null {
  if (Buffer.byteLength(rawBody, "utf8") > SLACK_EVENT_BODY_LIMIT) return null;
  try {
    const value = JSON.parse(rawBody) as unknown;
    if (!value || typeof value !== "object") return null;
    const body = value as Record<string, unknown>;
    if (body.type === "url_verification") {
      if (typeof body.challenge !== "string" || body.challenge.length === 0 || body.challenge.length > 2048) return null;
      return body as SlackUrlVerification;
    }
    if (body.type !== "event_callback" || typeof body.event_id !== "string" || body.event_id.length > 256 || !body.event || typeof body.event !== "object") return null;
    if (body.team_id !== undefined && (typeof body.team_id !== "string" || body.team_id.length === 0 || body.team_id.length > 128)) return null;
    if (body.api_app_id !== undefined && (typeof body.api_app_id !== "string" || body.api_app_id.length === 0 || body.api_app_id.length > 128)) return null;
    if (body.event_time !== undefined && (typeof body.event_time !== "number" || !Number.isFinite(body.event_time) || body.event_time < 0)) return null;
    const event = body.event as Record<string, unknown>;
    if (typeof event.type !== "string" || event.type.length > 128) return null;
    return body as unknown as SlackEventEnvelope;
  } catch {
    return null;
  }
}

export function isLifecycleSlackEvent(type: string): boolean {
  return type === "app_uninstalled" || type === "tokens_revoked" || type === "channel_shared";
}

export function isLinkSharedSlackEvent(type: string): type is "link_shared" {
  return type === "link_shared";
}

export function eventType(body: SlackEventEnvelope): string {
  return typeof body.event?.type === "string" ? body.event.type : "unknown";
}

export function eventLinks(body: SlackEventEnvelope): string[] {
  if (!isLinkSharedSlackEvent(eventType(body))) return [];
  const event = body.event as SlackLinkSharedEvent;
  return (event.links ?? []).flatMap((link) => (typeof link.url === "string" ? [link.url] : []));
}

export function eventChannel(body: SlackEventEnvelope): string | null {
  const event = body.event as Record<string, unknown>;
  const channel = event.channel ?? event.channel_id;
  return typeof channel === "string" ? channel : null;
}

export function eventPoster(body: SlackEventEnvelope): string | null {
  const event = body.event as Record<string, unknown>;
  const user = event.user ?? event.user_id;
  return typeof user === "string" ? user : null;
}

export function eventMessageTs(body: SlackEventEnvelope): string | null {
  const event = body.event as Record<string, unknown>;
  return typeof event.message_ts === "string" ? event.message_ts : null;
}

export function eventSource(body: SlackEventEnvelope): string | null {
  const event = body.event as Record<string, unknown>;
  return typeof event.source === "string" ? event.source : null;
}

export async function handleLifecycleSlackEvent(body: SlackEventEnvelope): Promise<void> {
  const teamId = body.team_id;
  const appId = body.api_app_id;
  const type = eventType(body);
  if (!teamId || !appId) return;
  try {
    if (type === "app_uninstalled") {
      await revokeSlackInstallation(teamId, appId, type);
      return;
    }
    if (type === "tokens_revoked") {
      const tokens = (body.event as { tokens?: { bot?: unknown; oauth?: unknown } } | undefined)?.tokens;
      const botTokens = Array.isArray(tokens?.bot) ? tokens.bot.filter((value): value is string => typeof value === "string") : [];
      const userTokens = Array.isArray(tokens?.oauth) ? tokens.oauth.filter((value): value is string => typeof value === "string") : [];
      // A revoked bot token invalidates the whole installation. A user OAuth
      // token revocation only invalidates the corresponding account links.
      if (botTokens.length > 0 || (botTokens.length === 0 && userTokens.length === 0)) await revokeSlackInstallation(teamId, appId, type);
      else await revokeSlackAccountLinks(teamId, appId, userTokens, type);
      return;
    }
    if (type === "channel_shared") {
      const channelId = eventChannel(body);
      if (channelId) await revokeSlackChannelApproval(teamId, appId, channelId, type);
    }
  } catch (error) {
    reportError(error, { tags: { surface: "slack_lifecycle_event" }, extra: { teamId, appId, type } });
    throw error;
  }
}
