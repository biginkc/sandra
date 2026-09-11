import type {
  Tables,
  TablesInsert,
  TablesUpdate,
} from "@/lib/supabase/types";

/** Display stages. A missing queue row is the derived Not contacted stage. */
export type QueueStage =
  | "not_contacted"
  | "contacted"
  | "needs_offer"
  | "offer_sent"
  | "under_contract";

export type StoredQueueStage = Exclude<QueueStage, "not_contacted">;
export type AcquisitionEpisodeKind = "live" | "launch";
export type AcquisitionAttemptKind = "call" | "outreach";
export type AcquisitionAttemptSource = "sandra" | "dialpad" | "manual";
export type AcquisitionAttemptOutcome =
  | "no_answer"
  | "reached"
  | "wrong_number";
export type AcquisitionOfferMethod =
  | "dropbox_sign"
  | "verbal"
  | "email_text";
export type AcquisitionOfferOutcome = "pending" | "accepted" | "declined";
export type AcquisitionLaunchCohortStatus =
  | "planned"
  | "running"
  | "complete"
  | "rolled_back";
export type AcquisitionArchiveReason =
  | "needs_sequence_handoff"
  | "under_contract_archived"
  | "manual";
export type AcquisitionMotivationKind = "specified" | "no_motivation";

export type AcquisitionAssignmentEpisode = Tables<
  "acquisition_assignment_episodes"
>;
export type AcquisitionAssignmentEpisodeInsert = TablesInsert<
  "acquisition_assignment_episodes"
>;
export type AcquisitionAssignmentEpisodeUpdate = TablesUpdate<
  "acquisition_assignment_episodes"
>;
export type AcquisitionAttempt = Tables<"acquisition_attempts">;
export type AcquisitionAttemptInsert = TablesInsert<"acquisition_attempts">;
export type AcquisitionAttemptUpdate = TablesUpdate<"acquisition_attempts">;
export type AcquisitionCommand = Tables<"acquisition_commands">;
export type AcquisitionCommandInsert = TablesInsert<"acquisition_commands">;
export type AcquisitionCommandUpdate = TablesUpdate<"acquisition_commands">;
export type AcquisitionLaunchCohort = Tables<"acquisition_launch_cohorts">;
export type AcquisitionLaunchCohortInsert = TablesInsert<
  "acquisition_launch_cohorts"
>;
export type AcquisitionLaunchCohortUpdate = TablesUpdate<
  "acquisition_launch_cohorts"
>;
export type AcquisitionOffer = Tables<"acquisition_offers">;
export type AcquisitionOfferInsert = TablesInsert<"acquisition_offers">;
export type AcquisitionOfferUpdate = TablesUpdate<"acquisition_offers">;
export type AcquisitionOrgSettings = Tables<"acquisition_org_settings">;
export type AcquisitionOrgSettingsInsert = TablesInsert<
  "acquisition_org_settings"
>;
export type AcquisitionOrgSettingsUpdate = TablesUpdate<
  "acquisition_org_settings"
>;
export type AcquisitionQueueState = Tables<"acquisition_queue_states">;
export type AcquisitionQueueStateInsert = TablesInsert<
  "acquisition_queue_states"
>;
export type AcquisitionQueueStateUpdate = TablesUpdate<
  "acquisition_queue_states"
>;

/** Every property mutation carries this compare-and-swap envelope. */
export type AcquisitionMutationEnvelope = {
  propertyId: string;
  expectedEpisodeId: string | null;
  expectedQueueVersion: number;
  idempotencyKey: string;
};

/** Property commands that also mutate the shared property status carry this CAS value. */
export type AcquisitionSharedStatusMutationEnvelope =
  AcquisitionMutationEnvelope & {
    expectedSharedStatus: string;
  };

export type AcquisitionWorkflowEnvelope =
  Omit<AcquisitionSharedStatusMutationEnvelope, "expectedEpisodeId"> & {
    orgId: string;
    expectedEpisodeId: string;
  };

export type AcquisitionTemperature = "hot" | "warm" | "cold" | null;

export type ReadyAcquisitionOfferInput = AcquisitionWorkflowEnvelope & {
  motivationResponse: AcquisitionMotivationResponse;
  temperature: AcquisitionTemperature;
};

export type LogAcquisitionOfferInput = AcquisitionWorkflowEnvelope & {
  amountCents: number;
  method: AcquisitionOfferMethod;
  sentAt: string;
  followUpAt: string;
  motivationResponse: AcquisitionMotivationResponse | null;
  temperature: AcquisitionTemperature;
};

export type RecordAcquisitionContractInput = AcquisitionWorkflowEnvelope & {
  signedAt: string;
  offerId: string | null;
};

export type DeclineAcquisitionOfferInput = AcquisitionWorkflowEnvelope & {
  pendingOfferId: string;
  occurredAt: string;
};

export type HandoffAcquisitionLeadInput = AcquisitionWorkflowEnvelope & {
  reason: "not_interested" | "needs_nurture";
  recipientUserId: string;
};

export type ArchiveAcquisitionContractInput = AcquisitionWorkflowEnvelope;

export type SetAcquisitionDesignationInput = {
  orgId: string;
  userId: string;
  enabled: boolean;
  expectedEnabled: boolean;
  idempotencyKey: string;
};

export type SetAcquisitionSettingsInput = {
  orgId: string;
  needsSequenceOwnerId: string;
  expectedSettingsRevision: number;
  idempotencyKey: string;
};

export type AcquisitionErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "FEATURE_DISABLED"
  | "NOT_FOUND"
  | "STALE_ASSIGNMENT"
  | "STALE_STATE"
  | "DNC_LOCKED"
  | "INVALID_INPUT"
  | "IDEMPOTENCY_CONFLICT"
  | "RECIPIENT_UNAVAILABLE"
  | "PENDING_OFFER_EXISTS"
  | "PROVIDER_EVIDENCE_PENDING";

export type AcquisitionCommandSuccess = {
  ok: true;
  duplicate: boolean;
  propertyId: string;
  queueVersion: number;
  stage: QueueStage | null;
  archived: boolean;
  attemptId?: string;
  offerId?: string;
  assignmentEpisodeId?: string;
};

export type AcquisitionCommandFailure = {
  ok: false;
  code: AcquisitionErrorCode;
  message: string;
  fieldErrors?: Record<string, string>;
};

export type AcquisitionCommandResult =
  | AcquisitionCommandSuccess
  | AcquisitionCommandFailure;

export type AcquisitionMotivationResponse =
  | { kind: "specified"; text: string }
  | { kind: "no_motivation"; text: null };
