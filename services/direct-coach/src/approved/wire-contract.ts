export interface CoachWireVersions {
  readonly scriptVersion: string | null
  readonly scriptDigest: string | null
  readonly matcherVersion: string
}

export type CoachWireMessage = CoachWireVersions & (
  | { readonly type: 'transcript'; readonly speaker: 'rep' | 'seller'; readonly text: string; readonly isFinal: boolean; readonly ts: string }
  | { readonly type: 'objection_prompt'; readonly objectionId: string; readonly label: string; readonly sellerTurn: number; readonly classifierModel: string; readonly questionsSha256: string; readonly ts: string }
  | { readonly type: 'motivation_prompt'; readonly label: string; readonly subType?: string; readonly sellerTurn: number; readonly classifierModel: string; readonly questionsSha256: string; readonly ts: string }
)
