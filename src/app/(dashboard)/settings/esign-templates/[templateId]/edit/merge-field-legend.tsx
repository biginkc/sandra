import { Badge } from "@/components/ui/badge";

import { ESIGN_MERGE_FIELD_NAMES } from "../../types";

export function MergeFieldLegend() {
  return (
    <section aria-labelledby="merge-field-legend" className="space-y-2 rounded-xl border bg-card p-4">
      <div>
        <h2 id="merge-field-legend" className="font-medium">Sandra merge fields</h2>
        <p className="text-muted-foreground text-sm">
          Place each pre-seeded field from the Dropbox Sign editor. Names must
          match exactly; the iframe cannot create new Sandra merge labels.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {ESIGN_MERGE_FIELD_NAMES.map((name) => (
          <Badge key={name} variant="outline" className="font-mono font-normal">
            {name}
          </Badge>
        ))}
      </div>
    </section>
  );
}
