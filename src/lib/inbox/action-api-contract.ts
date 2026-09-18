/** Client/server metadata-action contract. No message sending is implied. */
export type InboxMetadataOutcome = "wrong_number" | "bad_number" | "not_interested" | "needs_sequence" | "nurture" | "opted_out";
export type InboxMetadataStep = {
    type: "outcome";
    value: InboxMetadataOutcome;
} | {
    type: "assign";
    userId: string | null;
};
/** Internal operation receipts may expose the newer durable adapters even
 * while the existing metadata editor continues to render its original
 * outcome/assignment definition shape. */
export type InboxOperationAction = "outcome" | "assign" | "promote" | "dismiss_unknown" | "restore_unknown";
export type InboxMetadataTarget = {
    kind: "conversation" | "unknown_sender_group";
    id: string;
};
export interface PrepareInboxActionRequest {
    idempotencyKey: string;
    targets: readonly InboxMetadataTarget[];
    definition: {
        version: 1;
        steps: readonly InboxMetadataStep[];
    };
}
export type InboxActionExclusion = "unsupported_target" | "unsupported_action" | "permanent_dnc_not_enabled" | "conversation_unavailable" | "property_unavailable" | "property_locked" | "training_target" | "assignee_unavailable" | "scope_too_large" | "source_baseline_unavailable";
export interface PreparedInboxActionItem {
    id: string;
    target: InboxMetadataTarget;
    propertyId: string | null;
    exclusion: InboxActionExclusion | null;
}
export interface PreparedInboxAction {
    preparationId: string;
    idempotencyKey: string;
    inputHash: string;
    expiresAt: string;
    definition: PrepareInboxActionRequest["definition"];
    items: readonly PreparedInboxActionItem[];
    eligibleCount: number;
    excludedCount: number;
    affectedPropertyCount: number;
    effectCount: number;
    smsSafetySummary: { contacts: number; linkedProperties: number; activeEnrollments: number } | null;
    /** A final review_reply step is only a display handoff. It is excluded
     * from metadata effects and requires a later sourceOperationId reply
     * preparation after the metadata operation reaches a terminal result. */
    followUp?: { kind: "review_reply"; template: string };
}
export interface AcceptInboxActionRequest {
    preparationId: string;
    idempotencyKey: string;
}
export interface AcceptedInboxAction {
    operationId: string;
    acceptedAt: string;
}
export type InboxStepState = "pending" | "running" | "succeeded" | "failed" | "conflicted" | "cancelled" | "blocked";
export interface InboxOperationStatus {
    operationId: string;
    acceptedAt: string;
    completed: boolean;
    result: "succeeded" | "partial" | "failed" | "cancelled" | null;
    items: readonly (PreparedInboxActionItem & {
        stepIds: readonly string[];
        state: InboxStepState | "excluded";
        code: string | null;
    })[];
    steps: readonly {
        id: string;
        action: InboxOperationAction;
        state: InboxStepState;
        code: string | null;
        receiptVersion: string;
        changed: boolean | null;
    }[];
}

export interface InboxAssigneeChoice { userId: string; label: string }

export type InboxActionRecovery = { state: "accepted"; operation: AcceptedInboxAction } | { state: "pending" | "expired_not_accepted"; operation: null };
