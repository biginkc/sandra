import { NextResponse } from "next/server";

import { getCallerMembershipsOrThrow, MembershipLookupError, type Membership } from "@/lib/auth/memberships";
import { DatabaseError } from "@/lib/errors/classes";
import { reportError } from "@/lib/errors/report";
import {
  listSlackPreviewInstallations,
  setSlackPreviewPolicy,
} from "@/lib/integrations/slack/unfurl-store";
import { createClient } from "@/lib/supabase/server";

const MAX_BODY_BYTES = 8 * 1024;

type PolicyRequest = {
  installationId?: unknown;
  orgId?: unknown;
  enabled?: unknown;
  sharingPolicyAcknowledged?: unknown;
};

export async function GET(request: Request) {
  try {
    const user = await signedInUser();
    if (!user) return Response.json({ error: "Sign in required." }, { status: 401 });
    const memberships = await getCallerMembershipsOrThrow();
    const requestedOrgId = new URL(request.url).searchParams.get("orgId") ?? new URL(request.url).searchParams.get("org_id");
    if (requestedOrgId && !memberships.some((membership) => membership.org_id === requestedOrgId && isActiveMembership(membership))) {
      return Response.json({ error: "Organization not found." }, { status: 404 });
    }
    const orgId = selectOrgId(request, memberships);
    if (!orgId) return NextResponse.json({ orgId: null, canManage: false, installations: [] });
    const membership = memberships.find((candidate) => candidate.user_id === user.id && candidate.org_id === orgId && isActiveMembership(candidate));
    if (!membership) return Response.json({ error: "Organization not found." }, { status: 404 });
    const installations = await listSlackPreviewInstallations({ orgId, userId: user.id });
    return NextResponse.json({
      orgId,
      canManage: membership.role === "owner",
      installations,
    });
  } catch (error) {
    if (error instanceof MembershipLookupError) return Response.json({ error: "Organization access is temporarily unavailable." }, { status: 503 });
    reportError(error, { tags: { surface: "slack_preview_policy_get" } });
    return Response.json({ error: "Slack preview policy is temporarily unavailable." }, { status: 503 });
  }
}

export async function POST(request: Request) {
  try {
    const user = await signedInUser();
    if (!user) return Response.json({ error: "Sign in required." }, { status: 401 });
    const body = await readBody(request);
    if (!isBoundedId(body.installationId) || !isBoundedId(body.orgId) || typeof body.enabled !== "boolean") {
      return Response.json({ error: "Installation, organization, and enabled are required." }, { status: 400 });
    }
    if (body.enabled && body.sharingPolicyAcknowledged !== true) {
      return Response.json({ error: "Policy acknowledgement is required when enabling Slack previews." }, { status: 400 });
    }
    const memberships = await getCallerMembershipsOrThrow();
    const membership = memberships.find((candidate) => candidate.user_id === user.id && candidate.org_id === body.orgId && isActiveMembership(candidate));
    if (!membership || membership.role !== "owner") {
      return Response.json({ error: "Only an active organization owner can change Slack preview policy." }, { status: 403 });
    }
    const result = await setSlackPreviewPolicy({ installationId: body.installationId, orgId: body.orgId, ownerId: user.id, enabled: body.enabled });
    return NextResponse.json({ ok: true, mode: result.mode, policyRevision: result.policyRevision });
  } catch (error) {
    const code = databaseCode(error);
    if (code === "OWNER_NOT_ACTIVE") return Response.json({ error: "Only an active organization owner can change Slack preview policy." }, { status: 403 });
    if (code === "INSTALLATION_NOT_ACTIVE" || code === "INSTALLATION_SCOPE_MISSING") return Response.json({ error: "Slack installation is not eligible for this policy." }, { status: 409 });
    if (error instanceof MembershipLookupError) return Response.json({ error: "Organization access is temporarily unavailable." }, { status: 503 });
    if (error instanceof SyntaxError || error instanceof PolicyBodyError) return Response.json({ error: error.message }, { status: error instanceof PolicyBodyError && error.message === "Request is too large." ? 413 : 400 });
    reportError(error, { tags: { surface: "slack_preview_policy_post" } });
    return Response.json({ error: "Slack preview policy is temporarily unavailable." }, { status: 503 });
  }
}

class PolicyBodyError extends Error {}

async function signedInUser() {
  const client = await createClient();
  const { data: { user } } = await client.auth.getUser();
  return user;
}

async function readBody(request: Request): Promise<PolicyRequest> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number.isFinite(Number(contentLength)) && Number(contentLength) > MAX_BODY_BYTES) throw new PolicyBodyError("Request is too large.");
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) throw new PolicyBodyError("Request is too large.");
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new PolicyBodyError("Invalid request.");
    return parsed as PolicyRequest;
  } catch {
    throw new PolicyBodyError("Invalid request.");
  }
}

function selectOrgId(request: Request, memberships: readonly Membership[]): string | null {
  const requested = new URL(request.url).searchParams.get("orgId") ?? new URL(request.url).searchParams.get("org_id");
  if (requested) return memberships.some((membership) => membership.org_id === requested && isActiveMembership(membership)) ? requested : null;
  const active = memberships.filter(isActiveMembership);
  return active.length === 1 ? active[0].org_id : null;
}

function isBoundedId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

function isActiveMembership(membership: Pick<Membership, "access_status" | "access_expires_at" | "deletion_prepared_at">): boolean {
  if (membership.access_status && membership.access_status !== "active") return false;
  if (membership.deletion_prepared_at) return false;
  if (!membership.access_expires_at) return true;
  const expiresAt = Date.parse(membership.access_expires_at);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

function databaseCode(error: unknown): string | null {
  if (!(error instanceof DatabaseError)) return null;
  const detail = error.details?.message;
  return typeof detail === "string" ? detail.match(/\b[A-Z][A-Z0-9_]+\b/)?.[0] ?? null : null;
}
