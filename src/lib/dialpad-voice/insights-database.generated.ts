// Additive schema contract for migration 20260913213439; SQL rehearsal verifies behavior.
import type { DialpadVoiceDatabase } from "./database.generated";
import type { Json } from "@/lib/supabase/types";
type InsightRow = {
  org_id: string; provider_call_id: string; call_activity_id: string;
  transcript_status: string; transcript_text: string | null; transcript_lines: Json | null; transcript_event_ms: number;
  summary_status: string; summary_text: string | null; summary_event_ms: number; updated_at: string;
};
export type DialpadInsightsDatabase = Omit<DialpadVoiceDatabase, "public"> & { public: Omit<DialpadVoiceDatabase["public"], "Tables" | "Functions"> & {
  Tables: DialpadVoiceDatabase["public"]["Tables"] & { dialpad_call_insights: {
    Row: InsightRow; Insert: Pick<InsightRow,"org_id"|"provider_call_id"|"call_activity_id"> & Partial<InsightRow>;
    Update: Partial<InsightRow>; Relationships: [];
  } };
  Functions: DialpadVoiceDatabase["public"]["Functions"] & { fn_store_dialpad_insight: {
    Args: { p_org_id: string; p_call_id: string; p_kind: string; p_event_ms: number; p_text: string; p_lines?: Json | null }; Returns: boolean;
  } };
} };
