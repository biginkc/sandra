import { formatDistanceToNow } from "date-fns/formatDistanceToNow";

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
import { createClient } from "@/lib/supabase/server";

import { CreateListForm } from "./create-list-form";
import { ListRowActions } from "./list-row-actions";

export const metadata = {
  title: "Lists · Sandra CRM",
};

export default async function ListsPage() {
  const supabase = await createClient();

  // Two queries: all lists in the org, and a count per list. Doing the
  // count in a view/group-by is cleaner than N+1, so we sum property_lists
  // and join back in memory.
  //
  // Sort: system-managed first (so the 20 PropStream-style buckets pin to
  // the top of every picker), then alphabetical by name. VAs will see the
  // same names in the same order on every page.
  const [listsRes, countsRes] = await Promise.all([
    supabase
      .from("lists")
      .select(
        "id, name, description, color, archived_at, created_at, system_managed",
      )
      .order("system_managed", { ascending: false })
      .order("name", { ascending: true }),
    supabase.from("property_lists").select("list_id"),
  ]);

  const countsByList = new Map<string, number>();
  for (const row of countsRes.data ?? []) {
    countsByList.set(row.list_id, (countsByList.get(row.list_id) ?? 0) + 1);
  }

  const allLists = listsRes.data ?? [];
  const active = allLists.filter((l) => !l.archived_at);
  const archived = allLists.filter((l) => l.archived_at);

  return (
    <Page>
      <PageHeader
        breadcrumb={[{ label: "Workspace" }, { label: "Lists" }]}
        title="Lists"
        description={
          <>
            Lists are named cohorts of properties. One list per kind-of-data —
            all Probate records to the <em>same</em> Probate list forever. Re-importing
            the same address into a <em>different</em> list is how you stack: a
            property on 3 lists is stronger motivation than any 1 list.
          </>
        }
      />

      <CreateListForm />

      {listsRes.error ? (
        <div className="text-destructive text-sm">
          Failed to load lists: {listsRes.error.message}
        </div>
      ) : null}

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold tracking-wide uppercase text-muted-foreground">
          Active ({active.length})
        </h2>
        <ListTable rows={active} countsByList={countsByList} archived={false} />
      </section>

      {archived.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold tracking-wide uppercase text-muted-foreground">
            Archived ({archived.length})
          </h2>
          <ListTable
            rows={archived}
            countsByList={countsByList}
            archived={true}
          />
        </section>
      ) : null}
    </Page>
  );
}

function ListTable({
  rows,
  countsByList,
  archived,
}: {
  rows: {
    id: string;
    name: string;
    description: string | null;
    color: string | null;
    archived_at: string | null;
    created_at: string;
    system_managed: boolean;
  }[];
  countsByList: Map<string, number>;
  archived: boolean;
}) {
  if (rows.length === 0) {
    return (
      <div className="text-muted-foreground border-border rounded-md border border-dashed p-6 text-center text-sm">
        {archived ? "No archived lists." : "No lists yet. Create one above or set a list name on the next CSV import."}
      </div>
    );
  }
  return (
    <div className="border-border rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Description</TableHead>
            <TableHead className="text-right">Members</TableHead>
            <TableHead>Created</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id}>
              <TableCell>
                <div className="flex items-center gap-2">
                  <Badge
                    variant="secondary"
                    style={
                      r.color
                        ? {
                            backgroundColor: `${r.color}22`,
                            color: r.color,
                            borderColor: `${r.color}55`,
                          }
                        : undefined
                    }
                  >
                    {r.name}
                  </Badge>
                  {r.system_managed ? (
                    <Badge
                      variant="outline"
                      className="text-muted-foreground text-[10px] uppercase tracking-wide"
                      title="System-managed list — pre-populated, can't be archived"
                    >
                      System
                    </Badge>
                  ) : null}
                </div>
              </TableCell>
              <TableCell className="text-muted-foreground text-sm">
                {r.description || "—"}
              </TableCell>
              <TableCell className="text-right font-mono text-sm">
                {countsByList.get(r.id) ?? 0}
              </TableCell>
              <TableCell className="text-muted-foreground text-sm">
                {formatDistanceToNow(new Date(r.created_at), {
                  addSuffix: true,
                })}
              </TableCell>
              <TableCell className="text-right">
                <ListRowActions
                  id={r.id}
                  name={r.name}
                  archived={!!r.archived_at}
                  systemManaged={r.system_managed}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
