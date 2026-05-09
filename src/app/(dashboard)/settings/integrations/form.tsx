"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useState, useTransition } from "react";
import {
  CalendarDays,
  CheckCircle2,
  MessageSquare,
  XCircle,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { callAction } from "@/lib/errors/call-action";
import { cn } from "@/lib/utils";

import {
  disconnectIntegration,
  setChannelEnabledAction,
  setTimezoneAction,
  type IntegrationStatus,
} from "./actions";

const TIMEZONES = [
  { value: "America/Chicago", label: "Central (America/Chicago)" },
  { value: "America/New_York", label: "Eastern (America/New_York)" },
  { value: "America/Denver", label: "Mountain (America/Denver)" },
  { value: "America/Los_Angeles", label: "Pacific (America/Los_Angeles)" },
  { value: "America/Phoenix", label: "Arizona (America/Phoenix)" },
] as const;

export function IntegrationsForm({ initial }: { initial: IntegrationStatus }) {
  const [slackEnabled, setSlackEnabled] = useState(initial.slack.enabled);
  const [googleEnabled, setGoogleEnabled] = useState(initial.google.enabled);
  const [timezone, setTimezoneValue] = useState(initial.timezone);
  const [pending, startTransition] = useTransition();

  const toggleSlack = (next: boolean) => {
    const previous = slackEnabled;
    setSlackEnabled(next);
    startTransition(async () => {
      const result = await callAction(setChannelEnabledAction("slack", next), {
        successMessage: "Slack preference saved",
        fallbackMessage: "Could not update Slack preference",
      });
      if (!result.ok) setSlackEnabled(previous);
    });
  };

  const toggleGoogle = (next: boolean) => {
    const previous = googleEnabled;
    setGoogleEnabled(next);
    startTransition(async () => {
      const result = await callAction(
        setChannelEnabledAction("google_calendar", next),
        {
          successMessage: "Calendar preference saved",
          fallbackMessage: "Could not update calendar preference",
        },
      );
      if (!result.ok) setGoogleEnabled(previous);
    });
  };

  const changeTimezone = (next: string) => {
    const previous = timezone;
    setTimezoneValue(next);
    startTransition(async () => {
      const result = await callAction(setTimezoneAction(next), {
        successMessage: "Timezone saved",
        fallbackMessage: "Could not update timezone",
      });
      if (!result.ok) setTimezoneValue(previous);
    });
  };

  const disconnect = (provider: "slack" | "google") => {
    startTransition(async () => {
      await callAction(disconnectIntegration(provider), {
        successMessage:
          provider === "slack"
            ? "Slack disconnected"
            : "Google Calendar disconnected",
        fallbackMessage: "Could not disconnect integration",
      });
    });
  };

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <div className="grid gap-4 lg:grid-cols-2">
        <ProviderCard
          icon={<MessageSquare aria-hidden className="size-4" />}
          title="Slack"
          description="Receive task assignment DMs with a one-click Mark Done button."
          connected={initial.slack.connected}
          connectedLabel={initial.slack.teamName ?? "Connected"}
          connectHref="/api/oauth/slack/start"
          connectLabel="Connect Slack"
          disconnectLabel="Disconnect Slack"
          toggleLabel="Send Slack DMs"
          enabled={slackEnabled}
          pending={pending}
          onToggle={toggleSlack}
          onDisconnect={() => disconnect("slack")}
          testIdPrefix="slack"
        />

        <ProviderCard
          icon={<CalendarDays aria-hidden className="size-4" />}
          title="Google Calendar"
          description="Create 30-minute calendar events for assigned follow-up tasks."
          connected={initial.google.connected}
          connectedLabel={initial.google.email ?? "Connected"}
          connectHref="/api/oauth/google/start"
          connectLabel="Connect Google Calendar"
          disconnectLabel="Disconnect Google Calendar"
          toggleLabel="Create calendar events"
          enabled={googleEnabled}
          pending={pending}
          onToggle={toggleGoogle}
          onDisconnect={() => disconnect("google")}
          testIdPrefix="google"
        />
      </div>

      <section className="rounded-md border p-4">
        <div className="flex max-w-xl flex-col gap-2">
          <label htmlFor="integration-timezone" className="text-sm font-medium">
            Timezone for calendar events
          </label>
          <select
            id="integration-timezone"
            value={timezone}
            disabled={pending}
            onChange={(event) => changeTimezone(event.target.value)}
            className="border-input bg-background h-10 rounded-md border px-3 text-sm"
          >
            {TIMEZONES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <p className="text-muted-foreground text-sm">
            Calendar events stay scheduled even after a task is completed.
            Remove them manually in Google Calendar if needed.
          </p>
        </div>
      </section>
    </div>
  );
}

function ProviderCard({
  icon,
  title,
  description,
  connected,
  connectedLabel,
  connectHref,
  connectLabel,
  disconnectLabel,
  toggleLabel,
  enabled,
  pending,
  onToggle,
  onDisconnect,
  testIdPrefix,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  connected: boolean;
  connectedLabel: string;
  connectHref: string;
  connectLabel: string;
  disconnectLabel: string;
  toggleLabel: string;
  enabled: boolean;
  pending: boolean;
  onToggle: (next: boolean) => void;
  onDisconnect: () => void;
  testIdPrefix: "slack" | "google";
}) {
  return (
    <Card className="rounded-md">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {icon}
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
        <CardAction>
          <StatusBadge connected={connected} label={connectedLabel} />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {connected ? (
          <>
            <label className="flex items-center justify-between gap-4 rounded-md border p-3 text-sm">
              <span className="flex flex-col gap-1">
                <span className="font-medium">{toggleLabel}</span>
                <span className="text-muted-foreground text-xs">
                  Applies only to new task dispatches.
                </span>
              </span>
              <input
                type="checkbox"
                role="switch"
                checked={enabled}
                disabled={pending}
                onChange={(event) => onToggle(event.target.checked)}
                data-testid={`${testIdPrefix}-enabled-toggle`}
                className="accent-primary size-5"
                aria-label={toggleLabel}
              />
            </label>
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={onDisconnect}
              >
                {disconnectLabel}
              </Button>
            </div>
          </>
        ) : (
          <div>
            <Link
              href={connectHref}
              className={cn(buttonVariants({ size: "sm" }))}
            >
              {connectLabel}
            </Link>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function StatusBadge({
  connected,
  label,
}: {
  connected: boolean;
  label: string;
}) {
  return connected ? (
    <Badge variant="secondary" className="gap-1">
      <CheckCircle2 aria-hidden className="size-3" />
      {label}
    </Badge>
  ) : (
    <Badge variant="outline" className="gap-1">
      <XCircle aria-hidden className="size-3" />
      Disconnected
    </Badge>
  );
}
