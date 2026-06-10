import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { isAdminEmail } from "@/lib/auth/allowlist";

import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { listSequences, type SequenceRow } from "./actions";
import { SequenceRowActions } from "./row-actions";

export default async function SequencesIndexPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const isAdmin = isAdminEmail(user?.email);

  const result = await listSequences();
  const sequences: SequenceRow[] = result.ok ? result.data : [];

  const active = sequences.filter((s) => !s.archived_at);
  const archived = sequences.filter((s) => s.archived_at);

  return (
    <Page>
      <PageHeader
        breadcrumb={[{ label: "Workspace" }, { label: "Sequences" }]}
        title="Sequences"
        description="Multi-step outreach recipes. V1: manual enrollment, `send_sms` + `change_status` actions, live-read templates."
        actions={isAdmin ? (
          <Link href="/sequences/new">
            <Button>New sequence</Button>
          </Link>
        ) : undefined}
      />

      {!result.ok && (
        <div className="text-destructive text-sm">
          Failed to load sequences: {result.error.message}
        </div>
      )}

      {active.length === 0 && archived.length === 0 && result.ok ? (
        <div className="text-muted-foreground text-sm">
          No sequences yet. Click &ldquo;New sequence&rdquo; to author one, or
          apply migration 018&apos;s starter library.
        </div>
      ) : null}

      {active.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold tracking-tight">Active</h2>
          <SequenceTable rows={active} isAdmin={isAdmin} />
        </section>
      )}

      {archived.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-muted-foreground text-sm font-semibold tracking-tight">
            Archived
          </h2>
          <SequenceTable rows={archived} isArchived isAdmin={isAdmin} />
        </section>
      )}
    </Page>
  );
}

function SequenceTable({
  rows,
  isArchived = false,
  isAdmin,
}: {
  rows: SequenceRow[];
  isArchived?: boolean;
  isAdmin: boolean;
}) {
  return (
    <div className="border-border overflow-x-auto rounded-md border">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-left text-xs uppercase">
          <tr>
            <th className="px-3 py-2">Name</th>
            <th className="px-3 py-2">Steps</th>
            <th className="px-3 py-2">Enrolled (active/paused)</th>
            <th className="px-3 py-2">Opt-out append</th>
            <th className="px-3 py-2">Active</th>
            <th className="px-3 py-2 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.id} className="border-border border-t">
              <td className="px-3 py-2">
                {isAdmin ? (
                  <Link
                    href={`/sequences/${s.id}/edit`}
                    className="font-medium hover:underline"
                  >
                    {s.name}
                  </Link>
                ) : (
                  <span className="font-medium">{s.name}</span>
                )}
                {s.description && (
                  <div className="text-muted-foreground text-xs">
                    {s.description}
                  </div>
                )}
              </td>
              <td className="px-3 py-2">{s.step_count}</td>
              <td className="px-3 py-2">{s.active_enrollment_count}</td>
              <td className="px-3 py-2">
                {s.append_opt_out ? (
                  <Badge variant="outline">auto</Badge>
                ) : (
                  <Badge variant="outline">off</Badge>
                )}
              </td>
              <td className="px-3 py-2">
                {s.active && !s.archived_at ? (
                  <Badge>active</Badge>
                ) : (
                  <Badge variant="outline">paused</Badge>
                )}
              </td>
              <td className="px-3 py-2 text-right">
                {isAdmin ? (
                  <SequenceRowActions
                    sequenceId={s.id}
                    isArchived={isArchived}
                  />
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
