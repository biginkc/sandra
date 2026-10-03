import { NextResponse } from "next/server";

import { getCallerMembershipsOrThrow } from "@/lib/auth/memberships";
import { reportError } from "@/lib/errors/report";
import {
  approveSlackChannel,
  loadSlackInstallationById,
} from "@/lib/integrations/slack/unfurl-store";
import { verifySlackChannelForApproval } from "@/lib/integrations/slack/unfurl-policy";
import { createClient } from "@/lib/supabase/server";

const MAX_BODY_BYTES = 8 * 1024;

type ApprovalRequest = {
  installationId?: unknown;
  orgId?: unknown;
  channelId?: unknown;
  sharingPolicyAcknowledged?: unknown;
};

export async function POST(request: Request) {
  try {
    const client = await createClient();
    const {
      data: { user },
    } = await client.auth.getUser();
    if (!user) return Response.json({ error: "Sign in required." }, { status: 401 });

    const contentLength = request.headers.get("content-length");
    if (contentLength && Number.isFinite(Number(contentLength)) && Number(contentLength) > MAX_BODY_BYTES) {
      return Response.json({ error: "Request is too large." }, { status: 413 });
    }
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
      return Response.json({ error: "Request is too large." }, { status: 413 });
    }
    let body: ApprovalRequest;
    try {
      body = JSON.parse(raw) as ApprovalRequest;
    } catch {
      return Response.json({ error: "Invalid request." }, { status: 400 });
    }
    if (
      !isBoundedId(body.installationId) ||
      !isBoundedId(body.orgId) ||
      !isBoundedId(body.channelId) ||
      body.sharingPolicyAcknowledged !== true
    ) {
      return Response.json({ error: "Installation, organization, channel, and policy acknowledgement are required." }, { status: 400 });
    }

    const memberships = await getCallerMembershipsOrThrow();
    const membership = memberships.find((candidate) => candidate.user_id === user.id && candidate.org_id === body.orgId);
    if (!membership || !isApprovalOperator(membership) || !isActiveMembership(membership)) {
      return Response.json({ error: "You cannot approve channels for this organization." }, { status: 403 });
    }

    const installation = await loadSlackInstallationById(body.installationId);
    if (!installation || installation.orgId !== body.orgId) {
      return Response.json({ error: "Slack installation not found." }, { status: 404 });
    }
    if (installation.status !== "active") {
      return Response.json({ error: "Slack installation is inactive." }, { status: 409 });
    }

    const destination = await verifySlackChannelForApproval({
      token: installation.botToken.reveal(),
      teamId: installation.teamId,
      channelId: body.channelId,
    });
    if (!destination.allowed) {
      return Response.json({ error: "Slack channel cannot be approved." }, { status: 403 });
    }

    const approvalId = await approveSlackChannel({
      installationId: installation.installationId,
      orgId: installation.orgId,
      channelId: body.channelId,
      approvedBy: user.id,
      sharingPolicyAcknowledged: true,
    });
    return NextResponse.json({ ok: true, approvalId });
  } catch (error) {
    reportError(error, { tags: { surface: "slack_channel_approval" } });
    return Response.json({ error: "Slack channel approval is temporarily unavailable." }, { status: 503 });
  }
}

function isBoundedId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

function isActiveMembership(membership: { access_status?: string | null; access_expires_at?: string | null; deletion_prepared_at?: string | null }): boolean {
  if (membership.access_status && membership.access_status !== "active") return false;
  if (membership.deletion_prepared_at) return false;
  return !(membership.access_expires_at && Date.parse(membership.access_expires_at) <= Date.now());
}

function isApprovalOperator(membership: { role?: string | null }): boolean {
  return membership.role === "owner";
}
