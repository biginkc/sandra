"use server";

import { after } from "next/server";
import { start } from "workflow/api";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import {
  applyBulkUpdate,
  previewBulkUpdate,
  type UpdatePreview,
} from "@/lib/csv/update-bulk";
import type { SubOperationId } from "@/lib/csv/update-operations";
import type { Mapping } from "@/lib/csv/validate";
import type { PreflightProbe } from "@/lib/csv/preflight";
import { LEAD_SOURCES } from "@/lib/leads/sources";
import { SUPPRESSED_DISPOS } from "@/lib/messaging/suppression";
import { csvImportWorkflow } from "@/workflows/csv-import";
import {
  importTerminalStatus,
  type ImportSideEffects,
} from "@/lib/csv/import-job-status";
import type { Json } from "@/lib/supabase/types";
import { REVIEWED_DATASET_VERSION } from "@/lib/csv/dataset-contract";
import { buildReviewContractSha256 } from "@/lib/csv/dataset";
import { IMPORT_SERVICE_PRICING } from "@/lib/csv/import-pricing";

import type { WizardSource } from "./wizard";

type MembershipRow = {
  org_id: string;
  role: string;
};

export type CreateImportJobParams = {
  filename: string;
  source: WizardSource;
  /** Free-form market string from the wizard. Per phase 02 D-01 the
   *  counties table is the source of truth — this string is NOT what
   *  gets written. The action server-resolves the canonical market
   *  from `counties.market` for the supplied countyId and uses that
   *  for csv_imports.market / jobs.input_params / workflow params. */
  market: string;
  /** county_id (FK to counties.id) chosen on the wizard's market
   *  dropdown. Required — server-validated against the counties table
   *  before any writes (T-02-03-01 mitigation). */
  countyId: string;
  /** Optional list name. Lookup-or-create within the importer's org. */
  listName: string | null;
  mapping: Mapping;
  /** Path within the csv-imports Storage bucket — uploaded by the wizard
   *  before this action runs. The workflow downloads it server-side to
   *  parse and ingest. */
  storagePath: string;
  /** Total row count from the client-side parse, stamped onto the jobs
   *  row immediately so the wizard's progress UI has a denominator
   *  before the workflow's first heartbeat. */
  totalRows: number;
  /** SHA-256 of the deterministic reviewed CSV bytes uploaded to Storage. */
  datasetSha256: string;
  /** Hash of reviewed bytes plus mapping and confirmation semantics. */
  reviewContractSha256: string;
  datasetVersion: number;
  dncRows: number;
  /** When true, the workflow bulk-records opt_in_marketing_written for every
   *  homeowner contact after ingest (operator attestation at import time). */
  smsConsent: boolean;
  /** When set, auto-enroll every imported property into this sequence after ingest. */
  sequenceId?: string | null;
  /** Operator's choice at the wizard's line-type interstitial: classify
   *  unlabeled phone numbers via Telnyx before ingest. False = those
   *  numbers are dropped by the ingest hard rule (and counted). */
  classifyLineTypes: boolean;
  requestCass: boolean;
  requestSkipTrace: boolean;
  maxEstimatedChargeUsd: number;
  /** Format-helper audit trail: when the wizard's auto-detect applied
   *  a vendor preset before this submit, the preset id + version + the
   *  transform stats are recorded on `jobs.input_params.preset`. Pure
   *  metadata — does not affect ingest behavior; replaying the same
   *  preset version against the original Storage blob yields identical
   *  output. */
  preset?: {
    id: string;
    version: number;
    stats: {
      rowsIn: number;
      rowsOut: number;
      rowsCollapsedDup: number;
      columnsAdded: string[];
      columnsRemoved: string[];
      notes: string[];
    };
  } | null;
};

export type CreateImportJobResult = { jobId: string };

async function checkpointWorkflowStartFailure(
  jobId: string,
  orgId: string,
  error: unknown,
  errorClass: "configuration" | "transient",
  messagePrefix: string,
): Promise<void> {
  const supabase = createAdminClient();
  const { data: checkpoint, error: checkpointError } = await supabase
    .from("jobs")
    .update({
      status: "failed",
      error_class: errorClass,
      error_message:
        `${messagePrefix} ` +
        (error instanceof Error ? error.message : String(error)),
      completed_at: new Date().toISOString(),
    })
    .eq("id", jobId)
    .eq("org_id", orgId)
    .eq("status", "queued")
    .select("id")
    .maybeSingle();
  if (checkpointError) {
    throw new Error(
      `workflow-start failure checkpoint: ${checkpointError.message}`,
    );
  }
  if (!checkpoint) {
    throw new Error(
      "workflow-start failure checkpoint: queued job was not updated",
    );
  }
}

export async function createImportJob(
  params: CreateImportJobParams,
): Promise<Result<CreateImportJobResult>> {
  try {
    const supabase = await createClient();
    const { data: userData } = await supabase.auth.getUser();
    const userId = userData.user?.id ?? null;
    if (!userId) {
      return {
        ok: false,
        error: { code: "NOT_AUTHENTICATED", message: "Not authenticated" },
      };
    }

    if (!LEAD_SOURCES.includes(params.source)) {
      return {
        ok: false,
        error: {
          code: "INVALID_SOURCE",
          message: `Unsupported source. Choose one of: ${LEAD_SOURCES.join(", ")}.`,
        },
      };
    }
    if (!/^[a-f0-9]{64}$/.test(params.datasetSha256)) {
      return {
        ok: false,
        error: {
          code: "INVALID_DATASET_CHECKSUM",
          message:
            "The reviewed dataset checksum is invalid. Run preflight again.",
        },
      };
    }
    if (!/^[a-f0-9]{64}$/.test(params.reviewContractSha256)) {
      return {
        ok: false,
        error: {
          code: "INVALID_REVIEW_CONTRACT",
          message:
            "The reviewed mapping contract is invalid. Run preflight again.",
        },
      };
    }
    if (params.datasetVersion !== REVIEWED_DATASET_VERSION) {
      return {
        ok: false,
        error: {
          code: "INVALID_DATASET_VERSION",
          message: "Run preflight again before importing.",
        },
      };
    }
    if (
      !Number.isInteger(params.dncRows) ||
      params.dncRows < 0 ||
      params.dncRows > params.totalRows
    ) {
      return {
        ok: false,
        error: {
          code: "INVALID_DNC_COUNT",
          message: "The DNC count no longer matches this dataset.",
        },
      };
    }
    const unavailableService = [
      params.requestCass ? IMPORT_SERVICE_PRICING.cass : null,
      params.classifyLineTypes ? IMPORT_SERVICE_PRICING.line_type : null,
      params.requestSkipTrace ? IMPORT_SERVICE_PRICING.skip_trace : null,
    ].find((service) => service && !service.configured);
    if (unavailableService) {
      return {
        ok: false,
        error: {
          code: "SERVICE_UNAVAILABLE",
          message:
            unavailableService.unavailableReason ??
            `${unavailableService.label} is unavailable during import.`,
        },
      };
    }
    if (
      !Number.isFinite(params.maxEstimatedChargeUsd) ||
      params.maxEstimatedChargeUsd < 0
    ) {
      return {
        ok: false,
        error: {
          code: "INVALID_COST_ESTIMATE",
          message: "The maximum estimated charge is invalid.",
        },
      };
    }

    const { data: memberships, error: membershipError } = await supabase
      .from("memberships")
      .select("org_id, role");
    if (membershipError || !memberships?.length) {
      return {
        ok: false,
        error: {
          code: "ORG_MEMBERSHIP_REQUIRED",
          message:
            membershipError?.message ?? "No organization membership found",
        },
      };
    }
    if (memberships.length !== 1) {
      return {
        ok: false,
        error: {
          code: "ORG_SELECTION_REQUIRED",
          message: "Choose one organization before importing.",
        },
      };
    }
    const orgId = (memberships as MembershipRow[])[0].org_id;
    if (!params.storagePath.startsWith(`${orgId}/`)) {
      return {
        ok: false,
        error: {
          code: "IMPORT_STORAGE_SCOPE_MISMATCH",
          message:
            "The uploaded dataset does not belong to the selected organization.",
        },
      };
    }

    // T-02-03-01 mitigation: validate the supplied countyId against
    // the counties table BEFORE inserting csv_imports. The query is
    // RLS-scoped to the user's org, so a cross-org countyId returns
    // no row → INVALID_COUNTY. The server-derived `county.market`
    // (NOT params.market) is what gets persisted on csv_imports / jobs
    // / workflow params — eliminates the trust boundary at the wizard
    // SET_MARKET dispatch.
    const { data: county, error: countyErr } = await supabase
      .from("counties")
      .select("id, market")
      .eq("id", params.countyId)
      .single();
    if (countyErr || !county) {
      return {
        ok: false,
        error: { code: "INVALID_COUNTY", message: "Invalid county" },
      };
    }
    const canonicalMarket = county.market;
    const canonicalCountyId = county.id;

    if (params.sequenceId && !params.smsConsent) {
      return {
        ok: false,
        error: {
          code: "SEQUENCE_REQUIRES_CONSENT",
          message:
            "Sequence enrollment requires the written SMS consent attestation.",
        },
      };
    }
    const expectedReviewContract = await buildReviewContractSha256({
      datasetSha256: params.datasetSha256,
      mapping: params.mapping,
      source: params.source,
      countyId: params.countyId,
      totalRows: params.totalRows,
      dncRows: params.dncRows,
      smsConsent: params.smsConsent,
      sequenceId: params.sequenceId ?? null,
      classifyLineTypes: params.classifyLineTypes,
      requestCass: params.requestCass,
      requestSkipTrace: params.requestSkipTrace,
    });
    if (expectedReviewContract !== params.reviewContractSha256) {
      return {
        ok: false,
        error: {
          code: "REVIEW_CONTRACT_MISMATCH",
          message:
            "The file, mapping, or confirmation choices changed. Run preflight again.",
        },
      };
    }
    if (params.sequenceId) {
      const { data: sequence, error: sequenceError } = await supabase
        .from("sequences")
        .select("id, org_id, active, archived_at")
        .eq("id", params.sequenceId)
        .maybeSingle();
      if (
        sequenceError ||
        !sequence ||
        sequence.org_id !== orgId ||
        !sequence.active ||
        sequence.archived_at
      ) {
        return {
          ok: false,
          error: {
            code: "INVALID_SEQUENCE",
            message:
              "Choose an active sequence from the selected organization.",
          },
        };
      }
    }

    const { data: importRow, error: importError } = await supabase
      .from("csv_imports")
      .insert({
        filename: params.filename,
        source: params.source,
        market: canonicalMarket,
        county_id: canonicalCountyId,
        org_id: orgId,
        total_rows: params.totalRows,
        storage_path: params.storagePath,
        user_id: userId,
        dataset_sha256: params.datasetSha256,
        dataset_version: params.datasetVersion,
        dnc_rows: params.dncRows,
      })
      .select("id, org_id")
      .single();

    if (importError) {
      return {
        ok: false,
        error: {
          code: "CSV_IMPORT_INSERT_FAILED",
          message: importError.message,
        },
      };
    }

    // Resolve the optional list — lookup by (org_id, name); create if missing.
    // Any error here is non-fatal for the import itself; we log and continue
    // without a listId. (The alternative — aborting a 10K-row ingest because
    // the list name had a funny character — is a worse UX.)
    let listId: string | null = null;
    let listResolutionError: string | null = null;
    if (params.listName) {
      try {
        listId = await resolveOrCreateList(
          supabase,
          importRow.org_id,
          params.listName,
          userId,
        );
      } catch (e) {
        listResolutionError = e instanceof Error ? e.message : String(e);
        reportError(e, {
          tags: { surface: "resolve_or_create_list" },
          extra: { listName: params.listName, orgId: importRow.org_id },
        });
        // Proceed without list membership.
      }
    }

    const { data: jobRow, error: jobError } = await supabase
      .from("jobs")
      .insert({
        type: "csv_import",
        status: "queued",
        org_id: orgId,
        total_items: params.totalRows,
        related_import_id: importRow.id,
        created_by: userId,
        title: `Import ${params.filename}`,
        description: `${params.source} → ${canonicalMarket}: ${params.totalRows} rows`,
        input_params: {
          filename: params.filename,
          source: params.source,
          market: canonicalMarket,
          // Mirror the workflow params on jobs.input_params so the
          // /jobs UI shows the same county_id the worker will use.
          countyId: canonicalCountyId,
          mapping: params.mapping as Record<string, string | null>,
          storagePath: params.storagePath,
          smsConsent: params.smsConsent,
          sequenceId: params.sequenceId ?? null,
          classifyLineTypes: params.classifyLineTypes,
          requestCass: params.requestCass,
          requestSkipTrace: params.requestSkipTrace,
          maxEstimatedChargeUsd: params.maxEstimatedChargeUsd,
          datasetSha256: params.datasetSha256,
          reviewContractSha256: params.reviewContractSha256,
          datasetVersion: params.datasetVersion,
          expectedTotalRows: params.totalRows,
          dncRows: params.dncRows,
          listName: params.listName,
          listId,
          listResolutionError,
          // Format-helper audit trail (null when no preset applied).
          preset: params.preset ?? null,
        },
      })
      .select("id")
      .single();

    if (jobError) {
      return {
        ok: false,
        error: {
          code: "JOB_INSERT_FAILED",
          message: jobError.message,
        },
      };
    }

    const admin = createAdminClient();
    const { error: provenanceError } = await admin
      .from("csv_import_job_provenance")
      .insert({
        job_id: jobRow.id,
        org_id: orgId,
        csv_import_id: importRow.id,
        storage_path: params.storagePath,
        source: params.source,
        market: canonicalMarket,
        county_id: canonicalCountyId,
        mapping: params.mapping as Json,
        list_id: listId,
        requested_by: userId,
        sms_consent: params.smsConsent,
        sequence_id: params.sequenceId ?? null,
        classify_line_types: params.classifyLineTypes,
        request_cass: params.requestCass,
        dataset_sha256: params.datasetSha256,
        review_contract_sha256: params.reviewContractSha256,
        dataset_version: params.datasetVersion,
        expected_total_rows: params.totalRows,
        expected_dnc_rows: params.dncRows,
        list_name: params.listName,
        list_resolution_error: listResolutionError,
      });
    if (provenanceError) {
      await checkpointWorkflowStartFailure(
        jobRow.id,
        orgId,
        provenanceError,
        "configuration",
        "Import provenance could not be sealed.",
      );
      return {
        ok: false,
        error: {
          code: "IMPORT_PROVENANCE_FAILED",
          message:
            "The import could not be queued safely. No rows were imported.",
        },
      };
    }

    // Kick off the workflow runner. start() returns immediately — the
    // workflow's first step picks up where we leave off here. Wrapped in
    // `after()` so the action's HTTP response goes out before the start
    // call's network I/O completes; if `start()` itself throws, we still
    // surface the jobId to the wizard (the workflow can be re-triggered
    // from /jobs in the worst case).
    after(async () => {
      try {
        await start(csvImportWorkflow, [
          {
            jobId: jobRow.id,
            csvImportId: importRow.id,
            storagePath: params.storagePath,
            source: params.source,
            market: canonicalMarket,
            // Workflow boundary handoff for D-04: the worker uses this
            // as the hot path and falls back to csv_imports.county_id
            // only if the workflow params arrive without it (legacy
            // jobs queued before this plan shipped).
            countyId: canonicalCountyId,
            orgId,
            mapping: params.mapping,
            listId,
            userId,
            smsConsent: params.smsConsent,
            sequenceId: params.sequenceId ?? null,
            classifyLineTypes: params.classifyLineTypes,
            requestCass: params.requestCass,
            requestSkipTrace: false,
            datasetSha256: params.datasetSha256,
            reviewContractSha256: params.reviewContractSha256,
            datasetVersion: params.datasetVersion,
            expectedTotalRows: params.totalRows,
            expectedDncRows: params.dncRows,
            listName: params.listName,
            listResolutionError,
          },
        ]);
      } catch (e) {
        reportError(e, {
          tags: { surface: "create_import_job_workflow_start" },
          extra: { jobId: jobRow.id },
        });
        await checkpointWorkflowStartFailure(
          jobRow.id,
          orgId,
          e,
          "configuration",
          "Workflow runner failed to start.",
        );
      }
    });

    return ok({ jobId: jobRow.id });
  } catch (e) {
    reportError(e, { tags: { surface: "create_import_job" } });
    return errFromUnknown(e, "CREATE_IMPORT_JOB_FAILED");
  }
}

export type ImportPreflightBatchResult = {
  existingRowIndexes: number[];
  trueDncRows: Array<{ rowIndex: number; reasons: string[] }>;
  smsSuppressedRows: Array<{ rowIndex: number; reasons: string[] }>;
};

/**
 * Server-side half of preflight. The client sends only normalized addresses
 * and phone numbers, in bounded batches, so a 50 MB file never crosses the
 * Server Action body limit in one request. RLS scopes every lookup to the
 * caller's organization.
 */
export async function runImportPreflightBatch(
  probes: PreflightProbe[],
): Promise<Result<ImportPreflightBatchResult>> {
  try {
    if (probes.length === 0) {
      return ok({
        existingRowIndexes: [],
        trueDncRows: [],
        smsSuppressedRows: [],
      });
    }
    if (probes.length > 250) {
      return {
        ok: false,
        error: {
          code: "PREFLIGHT_BATCH_TOO_LARGE",
          message: "Preflight batches are limited to 250 rows.",
        },
      };
    }
    const supabase = await createClient();
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) {
      return {
        ok: false,
        error: { code: "NOT_AUTHENTICATED", message: "Not authenticated" },
      };
    }

    const addresses = Array.from(
      new Set(
        probes
          .map((probe) => probe.addressNormalized)
          .filter((value): value is string => !!value),
      ),
    );
    const filePhones = Array.from(
      new Set(probes.flatMap((probe) => probe.phones)),
    );
    const trueDncReasonsByRow = new Map<number, Set<string>>();
    const smsReasonsByRow = new Map<number, Set<string>>();
    const addReason = (
      target: Map<number, Set<string>>,
      rowIndex: number,
      reason: string,
    ) => {
      const reasons = target.get(rowIndex) ?? new Set<string>();
      reasons.add(reason);
      target.set(rowIndex, reasons);
    };

    const propertiesResult = addresses.length
      ? await supabase
          .from("properties")
          .select("address_normalized, outreach_dispo, homeowner_contact_id")
          .in("address_normalized", addresses)
          .is("deleted_at", null)
      : { data: [], error: null };
    if (propertiesResult.error) throw propertiesResult.error;
    const propertyByAddress = new Map(
      (propertiesResult.data ?? []).map((row) => [row.address_normalized, row]),
    );
    const existingRowIndexes = probes
      .filter(
        (probe) =>
          probe.addressNormalized &&
          propertyByAddress.has(probe.addressNormalized),
      )
      .map((probe) => probe.rowIndex);

    const existingContactIds = Array.from(
      new Set(
        (propertiesResult.data ?? [])
          .map((property) => property.homeowner_contact_id)
          .filter((id): id is string => !!id),
      ),
    );
    const phoneList =
      filePhones.length > 0 ? `(${filePhones.join(",")})` : null;
    const [addressContactsResult, phoneContactsResult] = await Promise.all([
      existingContactIds.length > 0
        ? supabase
            .from("contacts")
            .select(
              "id, phone_1, phone_2, phone_3, do_not_contact, sms_opted_out",
            )
            .in("id", existingContactIds)
        : Promise.resolve({ data: [], error: null }),
      phoneList
        ? supabase
            .from("contacts")
            .select(
              "id, phone_1, phone_2, phone_3, do_not_contact, sms_opted_out",
            )
            .or(
              `phone_1.in.${phoneList},phone_2.in.${phoneList},phone_3.in.${phoneList}`,
            )
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (addressContactsResult.error) throw addressContactsResult.error;
    if (phoneContactsResult.error) throw phoneContactsResult.error;
    const contacts = Array.from(
      new Map(
        [
          ...(addressContactsResult.data ?? []),
          ...(phoneContactsResult.data ?? []),
        ].map((contact) => [contact.id, contact]),
      ).values(),
    );
    const contactById = new Map(
      contacts.map((contact) => [contact.id, contact]),
    );
    const contactByPhone = new Map<string, (typeof contacts)[number]>();
    for (const contact of contacts) {
      for (const phone of [contact.phone_1, contact.phone_2, contact.phone_3]) {
        if (phone) contactByPhone.set(phone, contact);
      }
    }
    const allPhones = Array.from(
      new Set([
        ...filePhones,
        ...contacts.flatMap((contact) =>
          [contact.phone_1, contact.phone_2, contact.phone_3].filter(
            (phone): phone is string => !!phone,
          ),
        ),
      ]),
    );
    const { data: suppressions, error: suppressionError } =
      allPhones.length > 0
        ? await supabase
            .from("sms_phone_suppressions")
            .select("phone_e164")
            .in("phone_e164", allPhones)
        : { data: [], error: null };
    if (suppressionError) throw suppressionError;
    const suppressedPhones = new Set(
      (suppressions ?? []).map((row) => row.phone_e164),
    );

    for (const probe of probes) {
      if (!probe.addressNormalized) continue;
      const property = propertyByAddress.get(probe.addressNormalized);
      if (property?.outreach_dispo === "dnc") {
        addReason(
          trueDncReasonsByRow,
          probe.rowIndex,
          "Existing record is permanently Do Not Contact",
        );
      } else if (
        property?.outreach_dispo &&
        SUPPRESSED_DISPOS.has(property.outreach_dispo as "dnc")
      ) {
        addReason(
          smsReasonsByRow,
          probe.rowIndex,
          `Existing record is suppressed for outreach (${property.outreach_dispo})`,
        );
      }
      const addressContact = property?.homeowner_contact_id
        ? contactById.get(property.homeowner_contact_id)
        : null;
      if (addressContact?.do_not_contact) {
        addReason(
          trueDncReasonsByRow,
          probe.rowIndex,
          "Existing contact is Do Not Contact",
        );
      }
      if (addressContact?.sms_opted_out) {
        addReason(
          smsReasonsByRow,
          probe.rowIndex,
          "Existing contact opted out of SMS",
        );
      }
      if (
        [
          addressContact?.phone_1,
          addressContact?.phone_2,
          addressContact?.phone_3,
        ].some((phone) => !!phone && suppressedPhones.has(phone))
      ) {
        addReason(
          smsReasonsByRow,
          probe.rowIndex,
          "Existing contact phone is in the durable SMS suppression registry",
        );
      }
      for (const phone of probe.phones) {
        const contact = contactByPhone.get(phone);
        if (contact?.do_not_contact) {
          addReason(
            trueDncReasonsByRow,
            probe.rowIndex,
            "Existing contact is Do Not Contact",
          );
        }
        if (contact?.sms_opted_out) {
          addReason(
            smsReasonsByRow,
            probe.rowIndex,
            "Existing contact opted out of SMS",
          );
        }
        if (suppressedPhones.has(phone)) {
          addReason(
            smsReasonsByRow,
            probe.rowIndex,
            "Phone is in the durable SMS suppression registry",
          );
        }
      }
    }

    return ok({
      existingRowIndexes,
      trueDncRows: [...trueDncReasonsByRow.entries()].map(
        ([rowIndex, reasons]) => ({
          rowIndex,
          reasons: [...reasons],
        }),
      ),
      smsSuppressedRows: [...smsReasonsByRow.entries()].map(
        ([rowIndex, reasons]) => ({
          rowIndex,
          reasons: [...reasons],
        }),
      ),
    });
  } catch (error) {
    reportError(error, { tags: { surface: "import_preflight" } });
    return errFromUnknown(error, "IMPORT_PREFLIGHT_FAILED");
  }
}

// ---------------------------------------------------------------------------
// Update mode
// ---------------------------------------------------------------------------

export type RunUpdatePreviewParams = {
  subOperationId: SubOperationId;
  rows: Record<string, string>[];
};

export async function runUpdatePreviewAction(
  params: RunUpdatePreviewParams,
): Promise<Result<UpdatePreview>> {
  try {
    const supabase = await createClient();
    const preview = await previewBulkUpdate(supabase, {
      subOperationId: params.subOperationId,
      rows: params.rows,
    });
    return ok(preview);
  } catch (e) {
    reportError(e, { tags: { surface: "run_update_preview" } });
    return errFromUnknown(e, "RUN_UPDATE_PREVIEW_FAILED");
  }
}

export type RunBulkUpdateJobParams = {
  subOperationId: SubOperationId;
  rows: Record<string, string>[];
  filename: string;
};

export type RunBulkUpdateJobResult = { jobId: string };

export async function runBulkUpdateJob(
  params: RunBulkUpdateJobParams,
): Promise<Result<RunBulkUpdateJobResult>> {
  try {
    const supabase = await createClient();
    const { data: userData } = await supabase.auth.getUser();
    const userId = userData.user?.id ?? null;

    const { data: jobRow, error: jobError } = await supabase
      .from("jobs")
      .insert({
        type: "csv_update",
        status: "queued",
        total_items: params.rows.length,
        created_by: userId,
        title: `Update ${params.filename}`,
        description: `${params.subOperationId}: ${params.rows.length} rows`,
        input_params: {
          subOperationId: params.subOperationId,
          filename: params.filename,
          rowCount: params.rows.length,
        },
      })
      .select("id")
      .single();

    if (jobError) {
      return {
        ok: false,
        error: { code: "JOB_INSERT_FAILED", message: jobError.message },
      };
    }

    after(async () => {
      try {
        await applyBulkUpdate(supabase, {
          subOperationId: params.subOperationId,
          rows: params.rows,
          userId,
          jobId: jobRow.id,
        });
      } catch (e) {
        reportError(e, {
          tags: { surface: "run_bulk_update_job_after" },
          extra: { jobId: jobRow.id },
        });
        await supabase
          .from("jobs")
          .update({
            status: "failed",
            error_class: "database",
            error_message: e instanceof Error ? e.message : String(e),
            completed_at: new Date().toISOString(),
          })
          .eq("id", jobRow.id);
      }
    });

    return ok({ jobId: jobRow.id });
  } catch (e) {
    reportError(e, { tags: { surface: "run_bulk_update_job" } });
    return errFromUnknown(e, "RUN_BULK_UPDATE_JOB_FAILED");
  }
}

/**
 * Lookup-or-create a list by (org_id, name). Used by the import wizard
 * to resolve the optional "Add to list" input to a concrete list_id
 * without making the user first go to /lists to create the list.
 * Names are trimmed. Case-insensitive match against existing lists so
 * "Absentee" and "absentee" don't accidentally create two lists.
 */
async function resolveOrCreateList(
  supabase: Awaited<ReturnType<typeof createClient>>,
  orgId: string,
  rawName: string,
  createdBy: string | null,
): Promise<string> {
  const name = rawName.trim();
  if (!name) throw new Error("List name is empty");

  // Case-insensitive match to honor REISift's "one list per data type"
  // guideline — typing "Probate" when a "probate" list exists reuses it.
  const { data: existing, error: lookupErr } = await supabase
    .from("lists")
    .select("id, archived_at")
    .eq("org_id", orgId)
    .ilike("name", name)
    .maybeSingle();
  if (lookupErr) throw new Error(`list lookup: ${lookupErr.message}`);
  if (existing) {
    // Reviving an archived list silently un-archives it. VAs typing a
    // name don't want a surprise "list is archived" error on import.
    if (existing.archived_at) {
      const { error: restoreError } = await supabase
        .from("lists")
        .update({ archived_at: null })
        .eq("id", existing.id);
      if (restoreError)
        throw new Error(`list restore: ${restoreError.message}`);
    }
    return existing.id;
  }

  const { data: created, error: createErr } = await supabase
    .from("lists")
    .insert({
      org_id: orgId,
      name,
      created_by: createdBy,
    })
    .select("id")
    .single();
  if (createErr) throw new Error(`list insert: ${createErr.message}`);
  return created.id;
}

/** Retry only the durable list-assignment side effect for an import. */
export async function retryImportListAssignment(
  jobId: string,
): Promise<Result<{ status: string }>> {
  try {
    const supabase = await createClient();
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) {
      return {
        ok: false,
        error: { code: "NOT_AUTHENTICATED", message: "Not authenticated" },
      };
    }
    const { data: job, error: jobError } = await supabase
      .from("jobs")
      .select(
        "id, org_id, type, status, result_summary, processed_items, succeeded_items, failed_items, total_items, related_import_id",
      )
      .eq("id", jobId)
      .single();
    if (jobError || !job) throw jobError ?? new Error("Import job not found");
    if (job.type !== "csv_import" || !job.related_import_id) {
      return {
        ok: false,
        error: {
          code: "LIST_ASSIGNMENT_NOT_RETRYABLE",
          message: "This is not a CSV import job.",
        },
      };
    }
    if (!["partial", "partially_completed"].includes(job.status)) {
      return {
        ok: false,
        error: {
          code: "LIST_ASSIGNMENT_NOT_RETRYABLE",
          message: `List assignment cannot be retried while the import is ${job.status}.`,
        },
      };
    }

    const { data: provenance, error: provenanceError } = await supabase
      .from("csv_import_job_provenance")
      .select("list_name")
      .eq("job_id", job.id)
      .eq("org_id", job.org_id)
      .eq("csv_import_id", job.related_import_id)
      .single();
    if (provenanceError || !provenance) {
      throw provenanceError ?? new Error("Import retry provenance not found");
    }
    const listName = provenance.list_name?.trim() ?? "";
    if (!listName) {
      return {
        ok: false,
        error: {
          code: "NO_LIST_ASSIGNMENT",
          message: "This import did not request a list.",
        },
      };
    }
    const listId = await resolveOrCreateList(
      supabase,
      job.org_id,
      listName,
      auth.user.id,
    );
    const { data: items, error: itemsError } = await supabase
      .from("job_items")
      .select("property_id")
      .eq("job_id", jobId)
      .in("status", ["success", "skipped"])
      .not("property_id", "is", null);
    if (itemsError) throw itemsError;

    const propertyIds = Array.from(
      new Set(
        (items ?? [])
          .map((item) => item.property_id)
          .filter((id): id is string => !!id),
      ),
    );
    if (propertyIds.length > 0) {
      const { data: ownedProperties, error: ownershipError } = await supabase
        .from("properties")
        .select("id")
        .eq("org_id", job.org_id)
        .in("id", propertyIds);
      if (ownershipError) throw ownershipError;
      if (
        new Set((ownedProperties ?? []).map((row) => row.id)).size !==
        propertyIds.length
      ) {
        throw new Error(
          "Imported property ownership could not be verified for list assignment.",
        );
      }
      const now = new Date().toISOString();
      const { error: assignmentError } = await supabase
        .from("property_lists")
        .upsert(
          propertyIds.map((propertyId) => ({
            org_id: job.org_id,
            property_id: propertyId,
            list_id: listId,
            last_added_at: now,
            last_added_by: auth.user.id,
            last_source_import_id: job.related_import_id,
          })),
          { onConflict: "property_id,list_id", ignoreDuplicates: false },
        );
      if (assignmentError) throw assignmentError;
      const { data: verifiedMemberships, error: verifyError } = await supabase
        .from("property_lists")
        .select("property_id")
        .eq("list_id", listId)
        .in("property_id", propertyIds);
      if (verifyError) throw verifyError;
      if (
        new Set((verifiedMemberships ?? []).map((row) => row.property_id))
          .size !== propertyIds.length
      ) {
        throw new Error(
          "List assignment verification did not include every imported property.",
        );
      }
    }

    const summary = (job.result_summary ?? {}) as Record<string, unknown>;
    const sideEffects = {
      ...((summary.sideEffects ?? {}) as ImportSideEffects),
      listAssignment: { status: "completed", assigned: propertyIds.length },
    } satisfies ImportSideEffects;
    const status = importTerminalStatus({
      totalRows: job.total_items,
      processedRows: job.processed_items,
      succeeded: job.succeeded_items,
      failed: job.failed_items,
      sideEffects,
    });
    const { error: updateError } = await createAdminClient()
      .from("jobs")
      .update({
        status,
        result_summary: { ...summary, sideEffects } as Json,
        completed_at: new Date().toISOString(),
      })
      .eq("id", jobId)
      .eq("org_id", job.org_id)
      .eq("type", "csv_import");
    if (updateError) throw updateError;
    return ok({ status });
  } catch (error) {
    reportError(error, { tags: { surface: "retry_import_list_assignment" } });
    return errFromUnknown(error, "LIST_ASSIGNMENT_RETRY_FAILED");
  }
}

export type CsvImportRetryAvailability = {
  state:
    | "retryable"
    | "in_flight"
    | "exhausted"
    | "manual_reconciliation"
    | "not_retryable";
  message: string | null;
};

type CsvImportRetryJob = {
  id: string;
  org_id: string;
  type: string;
  status: string;
  error_class: string | null;
  retry_count: number;
  max_retries: number;
};

async function availabilityForCsvImportRetry(
  job: CsvImportRetryJob,
): Promise<CsvImportRetryAvailability> {
  if (job.type !== "csv_import") {
    return {
      state: "not_retryable",
      message: "Only CSV import jobs can use this retry.",
    };
  }
  if (["queued", "running"].includes(job.status)) {
    return {
      state: "in_flight",
      message: "This import is already being processed.",
    };
  }
  if (
    !["failed", "partial", "partially_completed"].includes(job.status) ||
    ["validation", "authorization"].includes(job.error_class ?? "")
  ) {
    return {
      state: "not_retryable",
      message: "This import cannot be retried from its current state.",
    };
  }

  // The authenticated jobs read establishes tenant membership. The admin
  // client is used only for the service-role ledger, with both tenant keys.
  const admin = createAdminClient();
  const { data: unresolved, error: unresolvedError } = await admin
    .from("csv_import_line_type_outcomes")
    .select("phone_e164")
    .eq("job_id", job.id)
    .eq("org_id", job.org_id)
    .in("state", ["submitting", "ambiguous"])
    .limit(1);
  if (unresolvedError) throw unresolvedError;
  if (unresolved && unresolved.length > 0) {
    return {
      state: "manual_reconciliation",
      message:
        "Automatic retry is blocked to prevent a duplicate provider charge. An administrator must reconcile the unknown line-type lookup first.",
    };
  }
  if (job.retry_count >= job.max_retries) {
    return {
      state: "exhausted",
      message:
        "This import has used all of its retry attempts. Review Job details before starting a replacement import.",
    };
  }
  return { state: "retryable", message: null };
}

function unavailableRetryResult(
  availability: CsvImportRetryAvailability,
): Result<never> {
  const code =
    availability.state === "in_flight"
      ? "CSV_IMPORT_RETRY_IN_FLIGHT"
      : availability.state === "exhausted"
        ? "CSV_IMPORT_RETRY_EXHAUSTED"
        : availability.state === "manual_reconciliation"
          ? "CSV_IMPORT_RETRY_MANUAL_RECONCILIATION"
          : "JOB_NOT_RETRYABLE";
  return {
    ok: false,
    error: {
      code,
      message: availability.message ?? "This import cannot be retried.",
    },
  };
}

/** Return the durable retry state used by every CSV retry surface. */
export async function getCsvImportRetryAvailability(
  jobId: string,
): Promise<Result<CsvImportRetryAvailability>> {
  try {
    const supabase = await createClient();
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) {
      return {
        ok: false,
        error: { code: "NOT_AUTHENTICATED", message: "Not authenticated" },
      };
    }
    const { data: job, error } = await supabase
      .from("jobs")
      .select(
        "id, org_id, type, status, error_class, retry_count, max_retries",
      )
      .eq("id", jobId)
      .single();
    if (error || !job) throw error ?? new Error("Import job not found");
    return ok(await availabilityForCsvImportRetry(job));
  } catch (error) {
    reportError(error, { tags: { surface: "csv_import_retry_availability" } });
    return errFromUnknown(error, "CSV_IMPORT_RETRY_AVAILABILITY_FAILED");
  }
}

/** Resume a failed/partial CSV import on the same durable row checkpoints. */
export async function retryCsvImportJob(
  jobId: string,
): Promise<Result<{ jobId: string }>> {
  try {
    const supabase = await createClient();
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) {
      return {
        ok: false,
        error: { code: "NOT_AUTHENTICATED", message: "Not authenticated" },
      };
    }
    const { data: job, error } = await supabase
      .from("jobs")
      .select(
        "id, org_id, type, status, related_import_id, error_class, retry_count, max_retries",
      )
      .eq("id", jobId)
      .single();
    if (error || !job) throw error ?? new Error("Import job not found");
    if (job.type !== "csv_import") {
      return {
        ok: false,
        error: {
          code: "JOB_NOT_CSV_IMPORT",
          message: "Only CSV import jobs can use this retry.",
        },
      };
    }
    const availability = await availabilityForCsvImportRetry(job);
    if (availability.state !== "retryable") {
      return unavailableRetryResult(availability);
    }
    if (!job.related_import_id) throw new Error("Import provenance is missing");

    const { data: provenance, error: provenanceError } = await supabase
      .from("csv_import_job_provenance")
      .select("*")
      .eq("job_id", jobId)
      .eq("org_id", job.org_id)
      .eq("csv_import_id", job.related_import_id)
      .maybeSingle();
    if (provenanceError || !provenance) {
      throw (
        provenanceError ??
        new Error("Authoritative import provenance is missing")
      );
    }
    const { data: importRow, error: importError } = await supabase
      .from("csv_imports")
      .select(
        "id, org_id, storage_path, source, market, county_id, dataset_sha256, dataset_version, dnc_rows, total_rows, user_id",
      )
      .eq("id", job.related_import_id)
      .eq("org_id", job.org_id)
      .maybeSingle();
    if (importError || !importRow) {
      throw importError ?? new Error("Authoritative import record is missing");
    }
    if (
      !importRow.storage_path?.startsWith(`${job.org_id}/`) ||
      importRow.storage_path !== provenance.storage_path
    ) {
      throw new Error("Stored import object is outside the job organization");
    }
    if (
      importRow.source !== provenance.source ||
      importRow.market !== provenance.market ||
      importRow.county_id !== provenance.county_id ||
      importRow.dataset_sha256 !== provenance.dataset_sha256 ||
      importRow.dataset_version !== provenance.dataset_version ||
      importRow.dnc_rows !== provenance.expected_dnc_rows ||
      importRow.total_rows !== provenance.expected_total_rows
    ) {
      throw new Error(
        "Stored import provenance no longer matches its immutable retry record",
      );
    }
    if (!LEAD_SOURCES.includes(importRow.source as WizardSource)) {
      throw new Error("Stored import source is unsupported");
    }
    if (provenance.list_id) {
      const { data: list, error: listError } = await supabase
        .from("lists")
        .select("id")
        .eq("id", provenance.list_id)
        .eq("org_id", job.org_id)
        .maybeSingle();
      if (listError || !list)
        throw (
          listError ?? new Error("Import list belongs to another organization")
        );
    }
    if (provenance.sequence_id) {
      const { data: sequence, error: sequenceError } = await supabase
        .from("sequences")
        .select("id")
        .eq("id", provenance.sequence_id)
        .eq("org_id", job.org_id)
        .eq("active", true)
        .is("archived_at", null)
        .maybeSingle();
      if (sequenceError || !sequence) {
        throw (
          sequenceError ??
          new Error("Import sequence is no longer active in this organization")
        );
      }
    }

    const { data: claimedJob, error: queueError } = await supabase.rpc(
      "claim_csv_import_retry",
      { p_job_id: jobId },
    );
    if (queueError) throw queueError;
    if (!claimedJob) {
      const { data: latestJob, error: latestJobError } = await supabase
        .from("jobs")
        .select(
          "id, org_id, type, status, error_class, retry_count, max_retries",
        )
        .eq("id", jobId)
        .single();
      if (latestJobError || !latestJob) {
        throw latestJobError ?? new Error("Import job not found after retry");
      }
      const latestAvailability = await availabilityForCsvImportRetry(latestJob);
      return latestAvailability.state === "retryable"
        ? unavailableRetryResult({
            state: "not_retryable",
            message: "This import could not be claimed for retry.",
          })
        : unavailableRetryResult(latestAvailability);
    }
    try {
      await start(csvImportWorkflow, [
        {
          jobId,
          csvImportId: job.related_import_id,
          storagePath: provenance.storage_path,
          source: provenance.source,
          market: provenance.market,
          countyId: provenance.county_id,
          orgId: job.org_id,
          mapping: provenance.mapping as Mapping,
          listId: provenance.list_id,
          userId: provenance.requested_by,
          smsConsent: provenance.sms_consent,
          sequenceId: provenance.sequence_id,
          classifyLineTypes: provenance.classify_line_types,
          requestCass: provenance.request_cass,
          requestSkipTrace: false,
          datasetSha256: provenance.dataset_sha256,
          reviewContractSha256: provenance.review_contract_sha256,
          datasetVersion: provenance.dataset_version,
          expectedTotalRows: provenance.expected_total_rows,
          expectedDncRows: provenance.expected_dnc_rows,
          listName: provenance.list_name,
          listResolutionError: provenance.list_resolution_error,
        },
      ]);
    } catch (startError) {
      await checkpointWorkflowStartFailure(
        jobId,
        job.org_id,
        startError,
        "transient",
        "The retry could not be queued. No rows were replayed.",
      );
      throw startError;
    }
    return ok({ jobId });
  } catch (error) {
    reportError(error, { tags: { surface: "retry_csv_import_job" } });
    return errFromUnknown(error, "CSV_IMPORT_RETRY_FAILED");
  }
}
