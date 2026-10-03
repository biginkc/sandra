"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

const POLICY_ENDPOINT = "/api/integrations/slack/policy";
const PREVIEW_RETURN_PATH = "/settings/integrations/slack-previews";
const READ_ERROR = "Slack preview settings are temporarily unavailable.";
const WRITE_ERROR = "Could not update Slack preview settings. Please try again.";

type SlackPreviewInstallation = {
  id: string;
  teamName: string | null;
  appId: string;
  status: "active" | "revoked";
  currentVersion: number;
  policyEnabled: boolean;
  accountLinked: boolean;
};

type SlackPreviewData = {
  orgId: string | null;
  canManage: boolean;
  installations: SlackPreviewInstallation[];
};

type PolicyMode = "eligible_internal_channels" | "disabled";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parsePolicyResponse(body: unknown): SlackPreviewData {
  const envelope = isRecord(body) && body.ok === true && isRecord(body.data) ? body.data : body;
  if (!isRecord(envelope) || (envelope.orgId !== null && typeof envelope.orgId !== "string") || typeof envelope.canManage !== "boolean" || !Array.isArray(envelope.installations)) {
    throw new Error(READ_ERROR);
  }

  const installations = envelope.installations.flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.id !== "string" || (candidate.teamName !== null && typeof candidate.teamName !== "string") || typeof candidate.appId !== "string" || typeof candidate.currentVersion !== "number" || typeof candidate.policyEnabled !== "boolean" || typeof candidate.accountLinked !== "boolean") return [];
    const status = candidate.status === "active" || candidate.status === "revoked" ? candidate.status : null;
    if (!status) return [];
    return [{
      id: candidate.id,
      teamName: candidate.teamName,
      appId: candidate.appId,
      status,
      currentVersion: candidate.currentVersion,
      policyEnabled: candidate.policyEnabled,
      accountLinked: candidate.accountLinked,
    } satisfies SlackPreviewInstallation];
  });

  if (installations.length !== envelope.installations.length) throw new Error(READ_ERROR);
  return { orgId: typeof envelope.orgId === "string" ? envelope.orgId : null, canManage: envelope.canManage, installations };
}

async function readPolicy(orgId: string | null): Promise<SlackPreviewData> {
  const endpoint = orgId
    ? `${POLICY_ENDPOINT}?orgId=${encodeURIComponent(orgId)}`
    : POLICY_ENDPOINT;
  const response = await fetch(endpoint, {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || (isRecord(body) && body.ok === false)) throw new Error(READ_ERROR);
  return parsePolicyResponse(body);
}

function connectHref(orgId: string | null): string {
  const base = `/api/oauth/slack/start?preview=1&return_to=${encodeURIComponent(PREVIEW_RETURN_PATH)}`;
  return orgId ? `${base}&org_id=${encodeURIComponent(orgId)}` : base;
}

function parsePolicyMutationMode(body: unknown): PolicyMode {
  if (!isRecord(body) || body.ok !== true) throw new Error(WRITE_ERROR);
  const responseData = isRecord(body.data) ? body.data : body;
  const mode = responseData.mode;
  if (mode === "eligible_internal_channels" || mode === "disabled") {
    return mode;
  }
  throw new Error(WRITE_ERROR);
}

export function SlackPreviewsClient({ orgId = null }: { orgId?: string | null }) {
  const [data, setData] = useState<SlackPreviewData | null>(null);
  const [selectedInstallationId, setSelectedInstallationId] = useState<string | null>(null);
  const [acknowledgedByInstallation, setAcknowledgedByInstallation] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setReadError(null);
    try {
      const next = await readPolicy(orgId);
      setData(next);
      setSelectedInstallationId((current) => current && next.installations.some((installation) => installation.id === current) ? current : next.installations[0]?.id ?? null);
    } catch {
      setReadError(READ_ERROR);
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    void Promise.resolve().then(() => load());
  }, [load]);

  if (loading) return <div role="status" className="text-muted-foreground text-sm">Loading Slack preview settings…</div>;

  if (readError || !data) {
    return (
      <div className="flex max-w-3xl flex-col gap-3" role="alert">
        <p className="text-destructive text-sm">{readError ?? READ_ERROR}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => void load()}>Try again</Button>
      </div>
    );
  }

  const installation = data.installations.find((candidate) => candidate.id === selectedInstallationId) ?? null;
  const connected = installation?.status === "active";
  const enabled = installation?.policyEnabled === true;
  const acknowledged = installation ? acknowledgedByInstallation[installation.id] ?? installation.policyEnabled : false;
  const canChange = data.canManage && connected && !saving;

  const updatePolicy = async (nextEnabled: boolean) => {
    if (!canChange || !installation || !data.orgId) return;
    if (nextEnabled && !acknowledged) {
      setNotice({ kind: "error", text: "Review and accept the sharing acknowledgement before enabling previews." });
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      const response = await fetch(POLICY_ENDPOINT, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          installationId: installation.id,
          orgId: data.orgId,
          enabled: nextEnabled,
          sharingPolicyAcknowledged: nextEnabled,
        }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || (isRecord(body) && body.ok === false)) throw new Error(WRITE_ERROR);
      const mode = parsePolicyMutationMode(body);
      const expectedMode: PolicyMode = nextEnabled
        ? "eligible_internal_channels"
        : "disabled";
      if (mode !== expectedMode) throw new Error(WRITE_ERROR);
      const policyEnabled = mode === "eligible_internal_channels";
      setData((current) => current ? {
        ...current,
        installations: current.installations.map((candidate) => candidate.id === installation.id ? { ...candidate, policyEnabled } : candidate),
      } : current);
      if (nextEnabled) setAcknowledgedByInstallation((current) => ({ ...current, [installation.id]: true }));
      setNotice({ kind: "success", text: nextEnabled ? "Slack lead previews enabled." : "Slack lead previews disabled." });
    } catch {
      setNotice({ kind: "error", text: WRITE_ERROR });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      {data.installations.length > 1 && (
        <label className="flex max-w-sm flex-col gap-1 text-sm">
          <span className="font-medium">Slack workspace</span>
          <select className="border-input bg-background h-10 rounded-md border px-3" value={installation?.id ?? ""} onChange={(event) => { setSelectedInstallationId(event.target.value); setNotice(null); }}>
            {data.installations.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.teamName ?? "Connected Slack workspace"}</option>)}
          </select>
        </label>
      )}

      {notice && <div role="status" data-variant={notice.kind} className={cn("rounded-md border px-4 py-3 text-sm", notice.kind === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-destructive/20 bg-destructive/10 text-destructive")}>{notice.text}</div>}

      <Card>
        <CardHeader>
          <CardTitle>Slack connection</CardTitle>
          <CardDescription>Connect your Slack account to let Sandra verify the workspace and show your connection status.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className={cn("inline-flex rounded-full px-2 py-1 text-xs font-medium", connected ? "bg-emerald-100 text-emerald-800" : "bg-muted text-muted-foreground")}>
              {connected ? "Workspace connected" : "Workspace not connected"}
            </span>
            {installation?.teamName && <span className="text-muted-foreground">{installation.teamName}</span>}
            <span className="text-muted-foreground">{installation?.accountLinked ? "Your account connected" : "Your account not connected"}</span>
          </div>
          {!installation?.accountLinked && (
            <div>
              <Link className={buttonVariants({ variant: "outline", size: "sm" })} href={connectHref(data.orgId)}>Connect Slack for previews</Link>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Workspace sharing</CardTitle>
          <CardDescription>Enable previews wherever Slack can verify an eligible internal channel. Direct messages and channels with unverifiable sharing stay excluded.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <label className="flex items-start gap-3 text-sm">
            <input type="checkbox" role="switch" aria-label="Enable Slack lead previews" className="mt-0.5" checked={enabled} disabled={!canChange} onChange={(event) => void updatePolicy(event.target.checked)} />
            <span>
              <span className="font-medium">Enable lead previews for eligible internal channels</span>
              <span className="text-muted-foreground block text-xs">{enabled ? "Lead links shared in eligible channels can show a preview." : "Lead previews are currently off for this organization."}</span>
            </span>
          </label>

          <label className="flex items-start gap-3 rounded-md border p-3 text-sm">
            <input type="checkbox" aria-label="Acknowledge Slack sharing" className="mt-0.5" checked={acknowledged} disabled={!data.canManage || saving} onChange={(event) => { setAcknowledgedByInstallation((current) => installation ? { ...current, [installation.id]: event.target.checked } : current); setNotice(null); }} />
            <span>I understand that anyone who can read an eligible Slack channel may also see lead facts and SMS excerpts through Slack retention, search, forwarding, or notifications.</span>
          </label>

          {!data.canManage && <p className="text-muted-foreground text-xs">Only organization owners can change this setting.</p>}
          {data.canManage && !connected && <p className="text-muted-foreground text-xs">Connect Slack before enabling lead previews.</p>}
        </CardContent>
      </Card>
    </div>
  );
}
