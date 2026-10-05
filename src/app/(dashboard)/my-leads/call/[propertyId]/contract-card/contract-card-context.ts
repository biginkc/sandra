import "server-only";

import { loadContractDefaults } from "@/lib/contract-defaults/queries";
import { resolveBuyerEntity, resolveTitleCompany } from "@/lib/contract-defaults/resolve";
import { getEsignFieldSchema } from "@/lib/esign/contracts";
import { createBoundLeadEsignCore } from "@/app/(dashboard)/leads/[id]/lead-esign-bindings";
import { ACQUISITION_TIME_ZONE } from "@/lib/my-leads/time";

import type { ContractCardState } from "../types";
import type { SendContext, Viewer } from "./contract-card-core";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseClient = any;

const ymd = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: ACQUISITION_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

/** Everything the card and the send action both need, loaded server-side (the browser is never trusted). */
export async function loadContractCardData(
  viewer: Viewer & { client: LooseClient },
  propertyId: string,
  templateId?: string,
): Promise<{ state: Extract<ContractCardState, { enabled: true }>; ctx: SendContext } | { reason: string }> {
  const preflight = await createBoundLeadEsignCore().preflight(propertyId);
  if (!preflight.ok) return { reason: "Contracts are not available for this lead." };
  const pf = preflight.data;
  const template = pf.templates.find((t) => (templateId ? t.id === templateId : getEsignFieldSchema(t.mergeFieldNames)?.version === "novation-v1"))
    ?? (templateId ? undefined : pf.templates[0]);
  const schema = template ? getEsignFieldSchema(template.mergeFieldNames) : null;
  if (!template || !schema) return { reason: "No contract template is ready." };

  const [defaults, prop, comp] = await Promise.all([
    loadContractDefaults(viewer.client, viewer.orgId),
    viewer.client.from("properties").select("market, state").eq("id", propertyId).eq("org_id", viewer.orgId).maybeSingle(),
    viewer.client.from("lead_comps").select("legal_description, legal_description_complete, confidence, fetched_at, provider, owner_of_record")
      .eq("org_id", viewer.orgId).eq("property_id", propertyId).order("fetched_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const addr = pf.residentialAddress ?? { street: pf.mergeDefaults.property_address, city: "", state: "", zip: "" };
  const c = (comp.error ? null : comp.data) as Record<string, unknown> | null;
  const now = new Date();
  const today = ymd(now);
  const tomorrow = ymd(new Date(now.getTime() + 24 * 3600 * 1000));
  const prefillBase = {
    schemaVersion: schema.version,
    fieldNames: template.mergeFieldNames,
    lead: {
      sellerName: pf.sellerDefaults.name, sellerEmail: pf.sellerDefaults.emailAddress, sellerPhone: null,
      street: addr.street, city: addr.city, state: addr.state, zip: addr.zip, fullAddress: pf.mergeDefaults.property_address,
    },
    comp: c
      ? {
          legalDescription: (c.legal_description as string | null) ?? null,
          legalComplete: c.legal_description_complete === true,
          confidence: (c.confidence as "high" | "medium" | "low" | null) ?? null,
          fetchedAt: (c.fetched_at as string | null) ?? null,
          provider: (c.provider as "attom" | "fixture" | null) ?? null,
          ownerOfRecord: (c.owner_of_record as string | null) ?? null,
        }
      : null,
    settings: { earnestMoneyCents: defaults.earnestMoneyCents, templateFieldDefaults: defaults.templateFieldDefaults },
  } as SendContext["prefillBase"];
  const propRow = (prop.error ? null : prop.data) as { market: string | null; state: string | null } | null;
  const title = resolveTitleCompany(defaults, { market: propRow?.market ?? null, state: propRow?.state ?? addr.state });
  const buyer = resolveBuyerEntity(defaults);
  return {
    state: {
      enabled: true, testMode: pf.testMode, templateId: template.id, sellerRoleName: template.sellerRoleName,
      signerRoles: template.signerRoles, sellerSigner: pf.sellerDefaults, prefillBase,
      titleCompanies: defaults.titleCompanies.filter((t) => t.isActive),
      buyerEntities: defaults.buyerEntities.filter((b) => b.isActive),
      selectedTitleCompanyId: title?.id ?? null, selectedBuyerEntityId: buyer?.id ?? null,
      todayCentral: today, tomorrowCentral: tomorrow,
    },
    ctx: {
      prefillBase, titleCompanies: defaults.titleCompanies.filter((t) => t.isActive), buyerEntities: defaults.buyerEntities.filter((b) => b.isActive),
      todayCentral: today, tomorrowCentral: tomorrow,
    },
  };
}
