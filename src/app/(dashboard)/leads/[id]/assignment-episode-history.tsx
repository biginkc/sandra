import type { DetailFact } from "@/lib/my-leads/queries";

const date = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeZone: "America/Chicago",
});

/** Same wording as the My Leads detail panel's History group. */
export function episodeLabel(
  row: Pick<DetailFact, "kind" | "actorId" | "actorLabel" | "endedAt">,
  labels: Record<string, string>,
) {
  const who =
    row.actorLabel ?? (row.actorId ? labels[row.actorId] : undefined) ?? "Team member";
  return `${row.kind === "launch" ? "Initialized for" : "Assigned to"} ${who}${row.endedAt ? " (ended)" : ""}`;
}

/**
 * Assignment-episode history for a lead: who held it and when. `rows` is
 * null when the detail RPC is unavailable to this viewer; nothing renders.
 */
export function AssignmentEpisodeHistory({
  rows,
  labels,
}: {
  rows: DetailFact[] | null;
  labels: Record<string, string>;
}) {
  if (!rows || rows.length === 0) return null;
  return (
    <section
      className="border-border/60 border-b px-3 py-2.5"
      data-testid="lead-assignment-episodes"
      aria-label="Assignment history"
    >
      <h3 className="text-muted-foreground text-[10px] font-extrabold tracking-[0.08em] uppercase">
        Assignment history
      </h3>
      <ul className="mt-1.5 space-y-1.5">
        {rows.map((row) => (
          <li key={row.id} className="space-y-0.5">
            <p className="text-sm font-medium">{episodeLabel(row, labels)}</p>
            <p className="text-muted-foreground text-xs">
              <time dateTime={row.at}>{date.format(new Date(row.at))}</time>
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
