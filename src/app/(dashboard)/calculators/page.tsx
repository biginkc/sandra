import { notFound } from "next/navigation";

import { Page } from "@/components/page";
import {
  calculatorViewer,
  getCalculation,
  getCalculatorLead,
} from "@/lib/calculators/server";

import { saveCalculation, searchCalculatorLeads } from "./actions";
import CalculatorWorkspace from "./client";

export default async function CalculatorsPage({
  searchParams,
}: {
  searchParams: Promise<{ leadId?: string; calculationId?: string }>;
}) {
  const params = await searchParams;
  try {
    await calculatorViewer();
  } catch {
    notFound();
  }
  let initialSnapshot = null;
  let initialLead = null;
  try {
    if (params.calculationId) {
      initialSnapshot = await getCalculation(params.calculationId);
      initialLead = await getCalculatorLead(initialSnapshot.property_id);
    } else if (params.leadId) {
      initialLead = await getCalculatorLead(params.leadId);
    }
  } catch {
    notFound();
  }

  return (
    <Page>
      <CalculatorWorkspace
        key={initialSnapshot?.id ?? initialLead?.id ?? "standalone"}
        initialLead={initialLead}
        initialSnapshot={initialSnapshot}
        searchLeads={searchCalculatorLeads}
        saveCalculation={saveCalculation}
        initialProvenance={
          initialLead
            ? {
                source: initialSnapshot
                  ? "saved_calculation"
                  : "lead_calculations",
                leadId: initialLead.id,
              }
            : null
        }
      />
    </Page>
  );
}
