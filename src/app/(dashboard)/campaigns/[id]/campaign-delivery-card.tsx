import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export type CampaignDeliveryCardProps = {
  senderProvider: string | null;
  senderNumber: string | null;
  providerCampaignExternalId: string | null;
  providerCampaignName: string | null;
  /** True once the campaign has any outbound message row — the sender is
   *  immutable from that point on. */
  locked: boolean;
};

/**
 * Read-only Delivery snapshot for the campaign detail page: which provider
 * number the campaign sends from and whether that choice is still editable.
 * Creation is the edit path in v1 — this card never mutates anything.
 */
export function CampaignDeliveryCard({
  senderProvider,
  senderNumber,
  providerCampaignExternalId,
  providerCampaignName,
  locked,
}: CampaignDeliveryCardProps) {
  return (
    <Card data-testid="campaign-delivery-card">
      <CardHeader className="border-b">
        <CardTitle className="flex flex-wrap items-center justify-between gap-3 text-base">
          <span>Delivery</span>
          {locked ? (
            <Badge variant="secondary">Sender locked</Badge>
          ) : (
            <Badge variant="outline">Sender editable until first queue</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-3">
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase text-muted-foreground">
            Provider
          </div>
          <div className="mt-1 text-sm font-medium">
            {senderProvider ?? "—"}
          </div>
        </div>
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase text-muted-foreground">
            Sending number
          </div>
          <div className="mt-1 text-sm font-medium">
            {senderNumber ?? (
              <span className="text-destructive">Not set</span>
            )}
          </div>
        </div>
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase text-muted-foreground">
            Provider campaign
          </div>
          <div className="mt-1 text-sm font-medium">
            {providerCampaignName ?? providerCampaignExternalId ?? "None"}
          </div>
        </div>
      </CardContent>
      {!senderNumber ? (
        <div className="border-t px-6 py-4 text-xs text-muted-foreground">
          Set a sending number by editing this campaign before launching.
        </div>
      ) : null}
    </Card>
  );
}
