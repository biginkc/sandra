"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useRef, useState, useTransition } from "react";
import {
  CalendarDays,
  CheckCircle2,
  FileSignature,
  MessageCircle,
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { callAction } from "@/lib/errors/call-action";
import { cn } from "@/lib/utils";
import {
  connectDropboxSignAction,
  disconnectDropboxSignAction,
  setEsignSendingEnabledAction,
} from "@/lib/esign/actions";

import {
  disconnectIntegration,
  setChannelEnabledAction,
  setReminderPhoneAction,
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
  const [smsEnabled, setSmsEnabled] = useState(initial.sms.enabled);
  const [savedPhone, setSavedPhone] = useState(initial.sms.phone);
  const [phoneInput, setPhoneInput] = useState(initial.sms.phone ?? "");
  const [esign, setEsign] = useState(initial.esign);
  const [esignApiKey, setEsignApiKey] = useState("");
  const [esignConfirmation, setEsignConfirmation] = useState<boolean | null>(
    null,
  );
  const [esignDisconnectConfirmation, setEsignDisconnectConfirmation] =
    useState(false);
  const [esignDisconnectResult, setEsignDisconnectResult] = useState<{
    variant: "success" | "error";
    message: string;
  } | null>(null);
  const esignToggleRef = useRef<HTMLInputElement>(null);
  const esignDisconnectButtonRef = useRef<HTMLButtonElement>(null);
  const esignConfirmingRef = useRef(false);
  const esignDisconnectingRef = useRef(false);
  const [pending, startTransition] = useTransition();
  const esignOwnerReasonId = "esign-owner-required-description";
  const esignToggleDescriptionId = esign.canManage
    ? undefined
    : esignOwnerReasonId;

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

  const toggleSms = (next: boolean) => {
    const previous = smsEnabled;
    setSmsEnabled(next);
    startTransition(async () => {
      const result = await callAction(
        setChannelEnabledAction("sms_reminder", next),
        {
          successMessage: next
            ? "Text reminders turned on"
            : "Text reminders turned off",
          fallbackMessage: "Could not update text reminder preference",
        },
      );
      if (!result.ok) setSmsEnabled(previous);
    });
  };

  const savePhone = () => {
    startTransition(async () => {
      const result = await callAction(setReminderPhoneAction(phoneInput), {
        successMessage: "Reminder phone number saved",
        fallbackMessage: "Could not save phone number",
      });
      if (result.ok) setSavedPhone(phoneInput.trim());
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

  const connectEsign = () => {
    setEsignDisconnectResult(null);
    startTransition(async () => {
      const result = await callAction(connectDropboxSignAction(esignApiKey), {
        successMessage: "Dropbox Sign connected",
        fallbackMessage: "Could not connect Dropbox Sign",
      });
      if (result.ok) {
        setEsign(result.data);
        setEsignApiKey("");
      }
    });
  };

  const returnFocusToEsignToggle = () => {
    window.setTimeout(() => esignToggleRef.current?.focus(), 0);
  };

  const closeEsignConfirmation = () => {
    if (esignConfirmingRef.current) return;
    setEsignConfirmation(null);
    returnFocusToEsignToggle();
  };

  const returnFocusToEsignDisconnect = () => {
    window.setTimeout(() => esignDisconnectButtonRef.current?.focus(), 0);
  };

  const closeEsignDisconnectConfirmation = () => {
    if (esignDisconnectingRef.current) return;
    setEsignDisconnectConfirmation(false);
    returnFocusToEsignDisconnect();
  };

  const confirmEsignToggle = () => {
    const next = esignConfirmation;
    if (next === null || esignConfirmingRef.current) return;
    esignConfirmingRef.current = true;
    startTransition(async () => {
      try {
        const result = await callAction(
          setEsignSendingEnabledAction(next, true),
          {
            successMessage: next
              ? "eSign sending turned on"
              : "eSign sending turned off",
            fallbackMessage: "Could not update eSign sending",
          },
        );
        if (result.ok) {
          setEsign((current) => ({ ...current, sendingEnabled: next }));
        }
      } finally {
        esignConfirmingRef.current = false;
        setEsignConfirmation(null);
        returnFocusToEsignToggle();
      }
    });
  };

  const disconnectEsign = () => {
    setEsignDisconnectResult(null);
    setEsignDisconnectConfirmation(true);
  };

  const confirmEsignDisconnect = () => {
    if (esignDisconnectingRef.current) return;
    esignDisconnectingRef.current = true;
    startTransition(async () => {
      try {
        const result = await callAction(disconnectDropboxSignAction(true), {
          fallbackMessage: "Could not disconnect Dropbox Sign",
        });
        if (result.ok) {
          if (result.data.disconnected || !result.data.credentialsPresent) {
            setEsign({
              connected: false,
              canManage: true,
              sendingEnabled: false,
              disconnectPending: false,
              testMode: true,
              apiKeyLastFour: null,
            });
          } else {
            setEsign((current) => ({
              ...current,
              connected: true,
              sendingEnabled: result.data.sendingEnabled,
              disconnectPending: result.data.disconnectPending,
            }));
          }
          setEsignDisconnectResult({
            variant: "success",
            message: result.data.message,
          });
          setEsignDisconnectConfirmation(false);
          return;
        }
        setEsignDisconnectResult({
          variant: "error",
          message: result.error.message,
        });
        setEsignDisconnectConfirmation(false);
        returnFocusToEsignDisconnect();
      } finally {
        esignDisconnectingRef.current = false;
      }
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

        <Card className="rounded-md">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileSignature aria-hidden className="size-4" />
              Dropbox Sign
            </CardTitle>
            <CardDescription>
              Create and send contracts from Sandra with Dropbox Sign.
            </CardDescription>
            <CardAction>
              <StatusBadge
                connected={esign.connected}
                label={
                  esign.connected && esign.apiKeyLastFour
                    ? `Connected ·••••${esign.apiKeyLastFour}`
                    : "Connected"
                }
              />
            </CardAction>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="border-alert-warning/40 bg-alert-warning/10 rounded-md border px-3 py-2 text-sm">
              Test mode is always on for v1. Test signatures are not legally
              binding.
            </div>
            {esignDisconnectResult && (
              <p
                role={
                  esignDisconnectResult.variant === "error" ? "alert" : "status"
                }
                aria-label={
                  esignDisconnectResult.variant === "error"
                    ? "Dropbox Sign disconnect failed"
                    : "Dropbox Sign disconnect result"
                }
                className={
                  esignDisconnectResult.variant === "error"
                    ? "border-destructive/30 bg-destructive/5 text-destructive rounded-md border px-3 py-2 text-sm"
                    : "rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900"
                }
              >
                {esignDisconnectResult.message}
              </p>
            )}
            {esign.connected ? (
              <>
                <label className="flex items-center justify-between gap-4 rounded-md border p-3 text-sm">
                  <span className="flex flex-col gap-1">
                    <span className="font-medium">Enable contract sending</span>
                    <span className="text-muted-foreground text-xs">
                      {esign.disconnectPending
                        ? "Active signature work is still finishing."
                        : "Requires a verified callback and applies to new test-mode requests."}
                    </span>
                  </span>
                  <input
                    ref={esignToggleRef}
                    type="checkbox"
                    role="switch"
                    checked={esign.sendingEnabled}
                    disabled={
                      pending || !esign.canManage || esign.disconnectPending
                    }
                    onChange={(event) =>
                      setEsignConfirmation(event.target.checked)
                    }
                    data-testid="esign-enabled-toggle"
                    className="accent-primary size-5"
                    aria-label="Enable contract sending"
                    aria-expanded={esignConfirmation !== null}
                    aria-controls="esign-sending-confirmation"
                    aria-describedby={esignToggleDescriptionId}
                  />
                </label>
                <div className="flex flex-wrap gap-2">
                  {esign.canManage && (
                    <>
                      {!esign.disconnectPending && (
                        <Link
                          href="/settings/esign-templates"
                          className={cn(
                            buttonVariants({ variant: "outline", size: "sm" }),
                          )}
                        >
                          Manage templates
                        </Link>
                      )}
                      <Button
                        ref={esignDisconnectButtonRef}
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={pending}
                        onClick={disconnectEsign}
                      >
                        Disconnect Dropbox Sign
                      </Button>
                    </>
                  )}
                </div>
                {!esign.canManage && (
                  <p
                    id={esignOwnerReasonId}
                    className="text-muted-foreground text-xs"
                  >
                    Only organization owners can disconnect Dropbox Sign or
                    manage templates. The sending switch is disabled for
                    non-owner accounts.
                  </p>
                )}
                {esign.canManage && esign.disconnectPending && (
                  <p className="text-muted-foreground text-xs">
                    Callback handling stays on until active signatures finish.
                  </p>
                )}
              </>
            ) : esign.canManage ? (
              <div className="flex flex-col gap-2">
                <label
                  htmlFor="dropbox-sign-api-key"
                  className="text-sm font-medium"
                >
                  Primary API key
                </label>
                <p className="text-muted-foreground text-xs">
                  Use the Primary Key from your Dropbox Sign API settings so
                  callback signatures can be verified.
                </p>
                <input
                  id="dropbox-sign-api-key"
                  type="password"
                  autoComplete="off"
                  value={esignApiKey}
                  disabled={pending}
                  onChange={(event) => setEsignApiKey(event.target.value)}
                  className="border-input bg-background h-10 rounded-md border px-3 text-sm"
                />
                <div>
                  <Button
                    type="button"
                    size="sm"
                    disabled={pending || esignApiKey.trim().length < 8}
                    onClick={connectEsign}
                  >
                    Connect Dropbox Sign
                  </Button>
                </div>
              </div>
            ) : (
              <p className="text-muted-foreground text-sm">
                Ask an organization owner to connect Dropbox Sign.
              </p>
            )}
          </CardContent>
        </Card>
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

      {initial.sms.available && (
        <section className="rounded-md border p-4">
          <div className="flex max-w-xl flex-col gap-4">
            <div className="flex items-center gap-2 font-medium">
              <MessageCircle aria-hidden className="size-4" />
              Text message reminders
            </div>
            <p className="text-muted-foreground text-sm">
              Get a text 30 minutes before an appointment.
            </p>
            <div className="flex flex-col gap-2">
              <label htmlFor="reminder-phone" className="text-sm font-medium">
                Phone number
              </label>
              <div className="flex gap-2">
                <input
                  id="reminder-phone"
                  type="tel"
                  value={phoneInput}
                  disabled={pending}
                  onChange={(event) => setPhoneInput(event.target.value)}
                  placeholder="+18165551234"
                  className="border-input bg-background h-10 flex-1 rounded-md border px-3 text-sm"
                />
                <Button
                  type="button"
                  size="sm"
                  disabled={pending || phoneInput.trim() === (savedPhone ?? "")}
                  onClick={savePhone}
                >
                  Save
                </Button>
              </div>
            </div>
            <label className="flex items-center justify-between gap-4 rounded-md border p-3 text-sm">
              <span className="flex flex-col gap-1">
                <span className="font-medium">Send text reminders</span>
                <span className="text-muted-foreground text-xs">
                  Requires a saved phone number.
                </span>
              </span>
              <input
                type="checkbox"
                role="switch"
                checked={smsEnabled}
                disabled={pending || !savedPhone}
                onChange={(event) => toggleSms(event.target.checked)}
                data-testid="sms-enabled-toggle"
                className="accent-primary size-5"
                aria-label="Send text reminders"
              />
            </label>
          </div>
        </section>
      )}

      <Dialog
        open={esignConfirmation !== null}
        onOpenChange={(open) => {
          if (!open) closeEsignConfirmation();
        }}
      >
        <DialogContent id="esign-sending-confirmation">
          <DialogHeader>
            <DialogTitle>
              {esignConfirmation
                ? "Turn on contract sending?"
                : "Turn off contract sending?"}
            </DialogTitle>
            <DialogDescription>
              {esignConfirmation
                ? "New test-mode signature requests can be sent after you confirm."
                : "New signature requests will stay blocked after you confirm."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={closeEsignConfirmation}
            >
              Cancel
            </Button>
            <Button
              type="button"
              autoFocus
              disabled={pending}
              onClick={confirmEsignToggle}
            >
              {esignConfirmation ? "Turn on sending" : "Turn off sending"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={esignDisconnectConfirmation}
        onOpenChange={(open) => {
          if (!open) closeEsignDisconnectConfirmation();
        }}
      >
        <DialogContent id="esign-disconnect-confirmation">
          <DialogHeader>
            <DialogTitle>Disconnect Dropbox Sign?</DialogTitle>
            <DialogDescription>
              Sandra will remove the active Dropbox Sign connection after the
              database confirms it is safe. When it succeeds, new contract
              sending is off.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={closeEsignDisconnectConfirmation}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              autoFocus
              disabled={pending}
              onClick={confirmEsignDisconnect}
            >
              Disconnect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
