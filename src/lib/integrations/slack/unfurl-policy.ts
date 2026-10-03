import { WebClient } from "@slack/web-api";

export const SLACK_CANONICAL_ORIGIN = "https://sandra.bmhgroupkc.com";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LINKS_PER_EVENT = 5;
const MAX_URL_KEY_LENGTH = 3000;

export type ParsedSlackLeadLink = {
  originalUrl: string;
  propertyId: string;
  kind: "lead" | "my-leads";
};

export type SlackLinkParseResult =
  | { ok: true; link: ParsedSlackLeadLink }
  | { ok: false; reason: "unsupported_origin" | "unsupported_path" | "invalid_lead" | "ambiguous_lead" };

export function parseSlackLeadUrl(input: string): SlackLinkParseResult {
  if (input.length > MAX_URL_KEY_LENGTH) return { ok: false, reason: "unsupported_origin" };
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, reason: "unsupported_origin" };
  }
  const authority = input.match(/^https:\/\/([^/?#]*)/)?.[1];
  if (url.protocol !== "https:" || authority !== "sandra.bmhgroupkc.com" || url.hostname !== "sandra.bmhgroupkc.com" || url.username || url.password || url.port || /^https:\/\/[^/?#]*:443(?:[/?#]|$)/i.test(input)) {
    return { ok: false, reason: "unsupported_origin" };
  }
  if (url.pathname.startsWith("/leads/")) {
    const raw = url.pathname.slice("/leads/".length);
    if (!UUID_RE.test(raw) || raw.includes("/")) return { ok: false, reason: "invalid_lead" };
    return { ok: true, link: { originalUrl: input, propertyId: raw.toLowerCase(), kind: "lead" } };
  }
  if (url.pathname === "/my-leads") {
    const values = url.searchParams.getAll("lead");
    if (values.length !== 1 || !UUID_RE.test(values[0])) return { ok: false, reason: "ambiguous_lead" };
    return { ok: true, link: { originalUrl: input, propertyId: values[0].toLowerCase(), kind: "my-leads" } };
  }
  return { ok: false, reason: "unsupported_path" };
}

export function parseSlackLeadLinks(urls: readonly string[]): {
  links: ParsedSlackLeadLink[];
  denied: number;
  overLimit: boolean;
} {
  if (urls.length > MAX_LINKS_PER_EVENT) return { links: [], denied: urls.length, overLimit: true };
  const links: ParsedSlackLeadLink[] = [];
  for (const url of urls) {
    const parsed = parseSlackLeadUrl(url);
    if (parsed.ok) links.push(parsed.link);
  }
  return { links, denied: urls.length - links.length, overLimit: false };
}

export function buildSlackLeadDeepLink(propertyId: string): string {
  if (!UUID_RE.test(propertyId)) throw new Error("Invalid property id");
  return `${SLACK_CANONICAL_ORIGIN}/my-leads?lead=${propertyId.toLowerCase()}`;
}

export function escapeSlackText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export type SlackChannelApproval = {
  installationId: string;
  orgId: string;
  channelId: string;
  status: "active" | "revoked";
  sharingPolicyAcknowledged: boolean;
};

export type SlackConversationInfo = {
  id?: string;
  team_id?: string;
  context_team_id?: string;
  shared_team_ids?: string[];
  is_channel?: boolean;
  is_group?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
  is_archived?: boolean;
  is_shared?: boolean;
  is_ext_shared?: boolean;
  is_org_shared?: boolean;
  is_pending_ext_shared?: boolean;
  pending_shared?: string[] | boolean;
  pending_connected_team_ids?: string[];
  connected_team_ids?: string[];
  internal_team_ids?: string[];
  is_member?: boolean;
};

export type SlackUserInfo = {
  id?: string;
  deleted?: boolean;
  is_bot?: boolean;
  team_id?: string;
};

export type SlackDestinationDecision =
  | { allowed: true; channel: SlackConversationInfo; user: SlackUserInfo }
  | { allowed: false; reason: string; retryAfterSeconds?: number };

export function authorizeSlackDestination(input: {
  approval: SlackChannelApproval | null;
  expectedInstallationId: string;
  expectedOrgId: string;
  expectedTeamId: string;
  expectedChannelId: string;
  expectedPosterUserId: string;
  channel: SlackConversationInfo | null;
  user: SlackUserInfo | null;
}): SlackDestinationDecision {
  if (!input.approval || input.approval.status !== "active" || !input.approval.sharingPolicyAcknowledged) return { allowed: false, reason: "channel_not_approved" };
  if (input.approval.installationId !== input.expectedInstallationId || input.approval.orgId !== input.expectedOrgId || input.approval.channelId !== input.expectedChannelId) return { allowed: false, reason: "channel_binding_mismatch" };
  const channel = input.channel;
  const contextTeamId = channel?.context_team_id ?? channel?.team_id;
  if (!channel || channel.id !== input.expectedChannelId || contextTeamId !== input.expectedTeamId || hasForeignTeamId(channel.shared_team_ids, input.expectedTeamId) || hasForeignTeamId(channel.connected_team_ids, input.expectedTeamId) || hasForeignTeamId(channel.internal_team_ids, input.expectedTeamId)) return { allowed: false, reason: "channel_identity_unverified" };
  if (!channel.is_channel && !channel.is_group) return { allowed: false, reason: "channel_type_denied" };
  if (channel.is_im || channel.is_mpim || channel.is_archived || channel.is_shared || channel.is_ext_shared || channel.is_org_shared || channel.is_pending_ext_shared || hasPendingSharedTeams(channel.pending_shared) || (channel.pending_connected_team_ids?.length ?? 0) > 0 || channel.is_member !== true) return { allowed: false, reason: "channel_sharing_denied" };
  const user = input.user;
  if (!user || user.id !== input.expectedPosterUserId || user.team_id !== input.expectedTeamId || user.deleted === true || user.is_bot === true) return { allowed: false, reason: "poster_identity_denied" };
  return { allowed: true, channel, user };
}

export async function verifySlackDestination(input: {
  token: string;
  approval: SlackChannelApproval | null;
  installationId: string;
  orgId: string;
  teamId: string;
  channelId: string;
  posterUserId: string;
}): Promise<SlackDestinationDecision> {
  const preflight = preflightSlackApproval(input);
  if (preflight) return preflight;
  const slack = new WebClient(input.token, { timeout: 5000, retryConfig: { retries: 0 }, rejectRateLimitedCalls: true });
  try {
    const [channelResponse, userResponse] = await Promise.all([
      slack.conversations.info({ channel: input.channelId }),
      slack.users.info({ user: input.posterUserId }),
    ]);
    return authorizeSlackDestination({
      approval: input.approval,
      expectedInstallationId: input.installationId,
      expectedOrgId: input.orgId,
      expectedTeamId: input.teamId,
      expectedChannelId: input.channelId,
      expectedPosterUserId: input.posterUserId,
      channel: (channelResponse.channel ?? null) as SlackConversationInfo | null,
      user: (userResponse.user ?? null) as SlackUserInfo | null,
    });
  } catch (error) {
    const code = slackPlatformErrorCode(error);
    if (code && PERMANENT_SLACK_ERRORS.has(code)) {
      return { allowed: false, reason: permanentSlackReason(code) };
    }
    const retryAfterSeconds = getRetryAfterSeconds(error);
    return retryAfterSeconds === null
      ? { allowed: false, reason: "slack_authority_unavailable" }
      : { allowed: false, reason: "slack_authority_unavailable", retryAfterSeconds };
  }
}

/**
 * Verify a channel while an operator is explicitly approving it. The bot's
 * live conversations.info response is authoritative for the team, channel
 * kind, sharing state, and bot membership. Approval never trusts a channel
 * id copied from an unverified Slack event.
 */
export async function verifySlackChannelForApproval(input: {
  token: string;
  teamId: string;
  channelId: string;
}): Promise<{ allowed: true; channel: SlackConversationInfo } | { allowed: false; reason: string }> {
  const slack = new WebClient(input.token, { timeout: 5000, retryConfig: { retries: 0 }, rejectRateLimitedCalls: true });
  try {
    const response = await slack.conversations.info({ channel: input.channelId });
    const channel = (response.channel ?? null) as SlackConversationInfo | null;
    if (!channel || channel.id !== input.channelId) return { allowed: false, reason: "channel_identity_unverified" };
    const contextTeamId = channel.context_team_id ?? channel.team_id;
    if (contextTeamId !== input.teamId || hasForeignTeamId(channel.shared_team_ids, input.teamId) || hasForeignTeamId(channel.connected_team_ids, input.teamId) || hasForeignTeamId(channel.internal_team_ids, input.teamId)) return { allowed: false, reason: "channel_identity_unverified" };
    if (!channel.is_channel && !channel.is_group) return { allowed: false, reason: "channel_type_denied" };
    if (channel.is_im || channel.is_mpim || channel.is_archived || channel.is_shared || channel.is_ext_shared || channel.is_org_shared || channel.is_pending_ext_shared || hasPendingSharedTeams(channel.pending_shared) || (channel.pending_connected_team_ids?.length ?? 0) > 0 || channel.is_member !== true) {
      return { allowed: false, reason: "channel_sharing_denied" };
    }
    return { allowed: true, channel };
  } catch {
    return { allowed: false, reason: "slack_authority_unavailable" };
  }
}

function hasForeignTeamId(values: readonly string[] | undefined, expectedTeamId: string): boolean {
  return values?.some((teamId) => teamId !== expectedTeamId) ?? false;
}

function getRetryAfterSeconds(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as { code?: unknown; data?: { retry_after?: unknown; response_metadata?: { retryAfter?: unknown } }; retryAfter?: unknown };
  const value = candidate.code === "slack_webapi_rate_limited_error"
    ? candidate.retryAfter
    : candidate.data?.retry_after ?? candidate.data?.response_metadata?.retryAfter;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

const PERMANENT_SLACK_ERRORS = new Set([
  "account_inactive",
  "channel_not_found",
  "invalid_auth",
  "invalid_token",
  "is_archived",
  "missing_scope",
  "not_authed",
  "not_in_channel",
  "team_not_found",
  "token_expired",
  "token_revoked",
  "user_not_found",
]);

function slackPlatformErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as { data?: { error?: unknown }; statusCode?: unknown };
  if (candidate.statusCode === 401) return "invalid_auth";
  if (candidate.statusCode === 404) return "channel_not_found";
  return typeof candidate.data?.error === "string" ? candidate.data.error : null;
}

function permanentSlackReason(code: string): string {
  if (["account_inactive", "invalid_auth", "invalid_token", "not_authed", "team_not_found", "token_expired", "token_revoked"].includes(code)) return "installation_revoked";
  if (code === "missing_scope") return "installation_scope_missing";
  return `slack_${code}`;
}

function hasPendingSharedTeams(value: string[] | boolean | undefined): boolean {
  return value === true || (Array.isArray(value) && value.length > 0);
}

function preflightSlackApproval(input: {
  approval: SlackChannelApproval | null;
  installationId: string;
  orgId: string;
  channelId: string;
}): Extract<SlackDestinationDecision, { allowed: false }> | null {
  if (!input.approval || input.approval.status !== "active" || !input.approval.sharingPolicyAcknowledged) return { allowed: false, reason: "channel_not_approved" };
  if (input.approval.installationId !== input.installationId || input.approval.orgId !== input.orgId || input.approval.channelId !== input.channelId) return { allowed: false, reason: "channel_binding_mismatch" };
  return null;
}

export const SLACK_UNFURL_MAX_LINKS = MAX_LINKS_PER_EVENT;
