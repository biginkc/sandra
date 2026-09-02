"use client";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import type { DeliveryCatalog } from "@/lib/messaging/delivery";

type Props = {
  senderNumber: string;
  onSenderNumberChange: (value: string) => void;
  providerCampaignExternalId: string | null;
  onProviderCampaignChange: (value: string | null) => void;
  /** Synced catalog, or null while the parent is still loading it. */
  catalog: DeliveryCatalog | null;
  loading: boolean;
  error?: string | null;
  disabled?: boolean;
  /** Parent wires this to refreshDeliveryCatalog + a catalog re-fetch. */
  onRefresh: () => void;
  syncing: boolean;
};

const SELECT_CLASS =
  "border-input bg-background w-full rounded-md border px-3 py-2 text-sm";

function formatLastSynced(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const minutes = Math.round((Date.now() - then) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(iso).toLocaleDateString("en-US");
}

function titleCaseProvider(provider: string): string {
  return provider
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function senderLabel(provider: string, phoneE164: string): string {
  return `${titleCaseProvider(provider)} — ${phoneE164}`;
}

function providerCampaignLabel(
  provider: string,
  name: string | null,
  externalId: string,
): string {
  const suffix = externalId.slice(-6);
  const identity = `${titleCaseProvider(provider)}${suffix ? ` — ID ending ${suffix}` : ""}`;
  return name?.trim() ? `${name.trim()} — ${identity}` : `${identity} campaign`;
}

/**
 * Shared Delivery setup selector: required sending number + optional
 * provider campaign, both read from the synced provider catalog.
 * Provider-neutral by design — never names a specific provider.
 */
export function DeliverySelect({
  senderNumber,
  onSenderNumberChange,
  providerCampaignExternalId,
  onProviderCampaignChange,
  catalog,
  loading,
  error,
  disabled,
  onRefresh,
  syncing,
}: Props) {
  const senders = catalog?.senders ?? [];
  const providerCampaigns = catalog?.providerCampaigns ?? [];
  const catalogEmpty = catalog !== null && senders.length === 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="delivery-sender-number">Sending number</Label>
        <select
          id="delivery-sender-number"
          value={senderNumber}
          onChange={(event) => onSenderNumberChange(event.target.value)}
          disabled={disabled || loading || senders.length === 0}
          aria-invalid={error ? "true" : "false"}
          aria-describedby={error ? "delivery-sender-number-error" : undefined}
          className={SELECT_CLASS}
        >
          <option value="">Choose a sending number…</option>
          {senders.map((sender) => (
            <option key={sender.phoneE164} value={sender.phoneE164}>
              {senderLabel(sender.provider, sender.phoneE164)}
            </option>
          ))}
        </select>
        {error ? (
          <p
            id="delivery-sender-number-error"
            className="text-destructive text-xs"
            role="alert"
          >
            {error}
          </p>
        ) : null}
      </div>

      {providerCampaigns.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="delivery-provider-campaign">
            Provider campaign (optional)
          </Label>
          <select
            id="delivery-provider-campaign"
            value={providerCampaignExternalId ?? ""}
            onChange={(event) =>
              onProviderCampaignChange(event.target.value || null)
            }
            disabled={disabled || loading}
            className={SELECT_CLASS}
          >
            <option value="">None</option>
            {providerCampaigns.map((providerCampaign) => (
              <option
                key={providerCampaign.externalId}
                value={providerCampaign.externalId}
              >
                {providerCampaignLabel(
                  providerCampaign.provider,
                  providerCampaign.name,
                  providerCampaign.externalId,
                )}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-3">
        {loading ? (
          <p className="text-muted-foreground text-xs">
            Loading delivery options…
          </p>
        ) : catalogEmpty ? (
          <p className="text-muted-foreground text-xs">
            No approved sending numbers synced yet. Sync to pull the
            provider&apos;s purchased numbers.
          </p>
        ) : catalog?.lastSyncedAt ? (
          <p className="text-muted-foreground text-xs">
            Last synced {formatLastSynced(catalog.lastSyncedAt)}
          </p>
        ) : (
          <span />
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onRefresh}
          disabled={disabled || syncing}
        >
          {syncing ? "Syncing…" : "Sync"}
        </Button>
      </div>
    </div>
  );
}
