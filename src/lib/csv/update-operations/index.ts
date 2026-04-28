import { tagExistingPropertiesOp } from "./tag-existing-properties";
import { updateAgentEmailsOp } from "./update-agent-emails";
import { updateAgentPhonesOp } from "./update-agent-phones";
import { updateHomeownerEmailsOp } from "./update-homeowner-emails";
import { updateHomeownerPhonesOp } from "./update-homeowner-phones";
import { updateMotivationLevelOp } from "./update-motivation-level";
import { updatePropertyStatusOp } from "./update-property-status";

import type { SubOperationId, SubOperationModule } from "./types";

export type {
  SubOperationApplyArgs,
  SubOperationApplyOptions,
  SubOperationContext,
  SubOperationId,
  SubOperationModule,
  ParsedRow,
  RowResult,
} from "./types";

export const SUB_OPERATIONS: readonly SubOperationModule[] = [
  updatePropertyStatusOp,
  tagExistingPropertiesOp,
  updateMotivationLevelOp,
  updateHomeownerPhonesOp,
  updateAgentPhonesOp,
  updateHomeownerEmailsOp,
  updateAgentEmailsOp,
];

export const SUB_OPERATIONS_BY_ID: Readonly<
  Record<SubOperationId, SubOperationModule>
> = Object.freeze(
  Object.fromEntries(SUB_OPERATIONS.map((op) => [op.id, op])) as Record<
    SubOperationId,
    SubOperationModule
  >,
);

export function getSubOperation(id: SubOperationId): SubOperationModule {
  const op = SUB_OPERATIONS_BY_ID[id];
  if (!op) throw new Error(`Unknown sub-operation: ${id}`);
  return op;
}
