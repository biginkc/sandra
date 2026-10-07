import type { ReviewJevSummary } from "../queries";

const OUTCOME_LABELS: Record<string, string> = {
  new_lead: "New lead",
  wrong_number: "Wrong number",
  not_interested: "Not interested",
  nurture: "Nurture",
  opted_out: "Opted out",
  dnc: "DNC",
};

/**
 * Coverage + reviewed-agreement summary. Deliberately never presents
 * confidence as calibrated accuracy, and never treats an unreviewed
 * auto-applied decision as correct just because nobody has looked yet —
 * "agreement" is computed only over rows a human actually confirmed,
 * corrected, or explicitly marked reviewed. superseded and failed/held
 * (classifier failures + unclear, which never produced a decision) are
 * their own honest buckets, never folded into "auto-applied unreviewed".
 */
export function ReviewSummary({ summary }: { summary: ReviewJevSummary }) {
  const outcomes = Object.keys(summary.reviewedAgreement).sort();
  return (
    <div className="flex flex-col gap-4 rounded-md border p-4">
      <div className="flex flex-wrap gap-6 text-sm">
        <Stat label="Total decisions (this page)" value={summary.coverage.total} />
        <Stat label="Reviewed by a human" value={summary.coverage.reviewedByHuman} />
        <Stat label="Auto-applied, not yet reviewed" value={summary.coverage.autoAppliedUnreviewed} />
        <Stat label="Pending in Needs-a-decision" value={summary.coverage.pending} />
        <Stat label="Superseded" value={summary.coverage.superseded} />
        <Stat label="Failed / held (no decision made)" value={summary.coverage.failedOrHeld} />
      </div>
      <p className="text-xs text-muted-foreground">
        Coverage, not accuracy. Confidence scores are not a calibrated accuracy claim, and an
        auto-applied decision nobody has sampled yet is not counted as correct — only reviewed
        rows contribute to agreement below. Superseded and failed/held rows never applied
        anything and are excluded from agreement entirely.
      </p>
      {outcomes.length > 0 && (
        <table className="w-full border-collapse text-left text-sm">
          <thead>
            <tr className="border-b text-xs uppercase text-muted-foreground">
              <th className="py-1 pr-4">Proposed outcome</th>
              <th className="py-1 pr-4">Agreed on review</th>
              <th className="py-1 pr-4">Corrected on review</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {outcomes.map((outcome) => {
              const row = summary.reviewedAgreement[outcome];
              const total = row.agreed + row.corrected;
              return (
                <tr key={outcome} data-testid={`jev-agreement-row-${outcome}`}>
                  <td className="py-1 pr-4 font-medium">{OUTCOME_LABELS[outcome] ?? outcome}</td>
                  <td className="py-1 pr-4">
                    {row.agreed} / {total}
                  </td>
                  <td className="py-1 pr-4">
                    {row.corrected} / {total}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="text-2xl font-bold">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}
