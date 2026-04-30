import { formatDistanceToNow } from "date-fns/formatDistanceToNow";
import { notFound } from "next/navigation";

import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { isAdminEmail } from "@/lib/auth/allowlist";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { CreateConsumerDialog } from "./create-consumer-dialog";
import { RowActions } from "./row-actions";

export const metadata = {
  title: "Webhooks · Sandra CRM",
};

export type WebhookConsumerRow = {
  id: string;
  name: string;
  consumer_type: "lead" | "provider";
  default_source: string | null;
  enabled: boolean;
  revoked_at: string | null;
  last_used_at: string | null;
  notes: string | null;
  created_at: string;
};

/**
 * Admin-only listing of webhook consumers. Each row represents one
 * external integrator (Enzo dialer, a future PPC landing page, the
 * Tracerfy provider callback). Admins can:
 *
 *   - Add a new consumer (lead or provider)
 *   - Rotate its secret (one-time plaintext display)
 *   - Disable / re-enable
 *   - Edit free-text notes
 *
 * The plaintext secret is generated server-side and displayed exactly
 * once at creation or rotation. After that, only the SHA-256 hash
 * lives in the DB — refreshing this page never re-shows it.
 */
export default async function AdminWebhooksPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isAdminEmail(user.email)) {
    // 404 rather than advertise an admin surface to non-admins.
    notFound();
  }

  // Service-role client because the page reads every row. RLS only
  // grants reads to authenticated users, but we already gated above
  // and want predictable ordering across all rows regardless of who
  // created them.
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("webhook_consumers")
    .select(
      "id, name, consumer_type, default_source, enabled, revoked_at, last_used_at, notes, created_at",
    )
    .order("enabled", { ascending: false })
    .order("name", { ascending: true });

  const rows: WebhookConsumerRow[] = (data ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    consumer_type: r.consumer_type as "lead" | "provider",
    default_source: r.default_source,
    enabled: r.enabled,
    revoked_at: r.revoked_at,
    last_used_at: r.last_used_at,
    notes: r.notes,
    created_at: r.created_at,
  }));

  return (
    <Page>
      <PageHeader
        breadcrumb={[{ label: "Admin" }, { label: "Webhooks" }]}
        title="Webhooks"
        description="Per-consumer webhook secrets. Each row is one external integrator — Enzo's dialer, a PPC landing page, or a skip-trace provider's results callback. Each gets its own URL and rotation; revoking one never disturbs the others."
        actions={<CreateConsumerDialog />}
      />

      {error ? (
        <div className="text-destructive text-sm">
          Failed to load consumers: {error.message}
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="border-border flex flex-col items-center justify-center gap-3 rounded-md border p-12 text-center">
          <div className="text-foreground text-base font-semibold">
            No webhook consumers yet.
          </div>
          <p className="text-muted-foreground max-w-md text-sm">
            Add one to give an external integrator a unique URL + secret.
            They&apos;ll POST to the URL; we&apos;ll create a property + contact
            (lead intake) or match results back to a job (provider callback).
          </p>
          <CreateConsumerDialog />
        </div>
      ) : (
        <div className="border-border rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Default source</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead>Notes</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <ConsumerRow key={row.id} row={row} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Page>
  );
}

function ConsumerRow({ row }: { row: WebhookConsumerRow }) {
  return (
    <TableRow>
      <TableCell className="font-medium">{row.name}</TableCell>
      <TableCell>
        {row.consumer_type === "lead" ? (
          <Badge>lead</Badge>
        ) : (
          <Badge variant="secondary">provider</Badge>
        )}
      </TableCell>
      <TableCell className="text-muted-foreground text-sm">
        {row.default_source ? (
          <span className="font-mono text-xs">{row.default_source}</span>
        ) : (
          <span className="italic">—</span>
        )}
      </TableCell>
      <TableCell>
        {row.enabled ? (
          <Badge variant="secondary">enabled</Badge>
        ) : (
          <span className="flex flex-col gap-0.5">
            <Badge variant="outline">disabled</Badge>
            {row.revoked_at && (
              <span className="text-muted-foreground text-[10px]">
                revoked{" "}
                {formatDistanceToNow(new Date(row.revoked_at), {
                  addSuffix: true,
                })}
              </span>
            )}
          </span>
        )}
      </TableCell>
      <TableCell className="text-muted-foreground text-sm">
        {row.last_used_at
          ? formatDistanceToNow(new Date(row.last_used_at), {
              addSuffix: true,
            })
          : "never"}
      </TableCell>
      <TableCell className="text-muted-foreground max-w-xs text-sm">
        <span className="line-clamp-2 whitespace-pre-wrap">
          {row.notes ?? <span className="italic">—</span>}
        </span>
      </TableCell>
      <TableCell className="text-right">
        <RowActions
          id={row.id}
          name={row.name}
          consumerType={row.consumer_type}
          enabled={row.enabled}
          notes={row.notes}
        />
      </TableCell>
    </TableRow>
  );
}
