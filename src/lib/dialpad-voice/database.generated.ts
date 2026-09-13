// Generated from disposable PostgreSQL information_schema for migration 20260913210206.
// Supabase CLI typegen requires unavailable Docker; no existing schema types replaced.
// Additive RPC signatures correspond to migration 20260913210933.
import type { Database as BaseDatabase, Json } from "@/lib/supabase/types";

export type DialpadVoiceTables = {
  dialpad_recording_artifacts: {
    Row: {
      id: string;
      org_id: string;
      provider_call_id: string;
      provider_recording_id: string;
      recording_kind: string;
      intent_id: string | null;
      status: string;
      attempt_count: number;
      next_attempt_at: string;
      lease_token: string | null;
      lease_expires_at: string | null;
      last_error_code: string | null;
      storage_bucket: string | null;
      storage_path: string | null;
      content_sha256: string | null;
      byte_count: number | null;
      decoded_duration_seconds: number | null;
      media_type: string | null;
      verified_at: string | null;
      created_at: string;
      updated_at: string;
    };
    Insert: {
      id?: string;
      org_id: string;
      provider_call_id: string;
      provider_recording_id: string;
      recording_kind: string;
      intent_id?: string | null;
      status?: string;
      attempt_count?: number;
      next_attempt_at?: string;
      lease_token?: string | null;
      lease_expires_at?: string | null;
      last_error_code?: string | null;
      storage_bucket?: string | null;
      storage_path?: string | null;
      content_sha256?: string | null;
      byte_count?: number | null;
      decoded_duration_seconds?: number | null;
      media_type?: string | null;
      verified_at?: string | null;
      created_at?: string;
      updated_at?: string;
    };
    Update: {
      id?: string;
      org_id?: string;
      provider_call_id?: string;
      provider_recording_id?: string;
      recording_kind?: string;
      intent_id?: string | null;
      status?: string;
      attempt_count?: number;
      next_attempt_at?: string;
      lease_token?: string | null;
      lease_expires_at?: string | null;
      last_error_code?: string | null;
      storage_bucket?: string | null;
      storage_path?: string | null;
      content_sha256?: string | null;
      byte_count?: number | null;
      decoded_duration_seconds?: number | null;
      media_type?: string | null;
      verified_at?: string | null;
      created_at?: string;
      updated_at?: string;
    };
    Relationships: [];
  };
  dialpad_voice_event_inbox: {
    Row: {
      id: string;
      org_id: string;
      envelope_sha256: string;
      payload: Json;
      received_at: string;
      status: string;
      attempt_count: number;
      next_attempt_at: string;
      lease_token: string | null;
      lease_expires_at: string | null;
      last_error_code: string | null;
      processed_at: string | null;
    };
    Insert: {
      id?: string;
      org_id: string;
      envelope_sha256: string;
      payload: Json;
      received_at?: string;
      status?: string;
      attempt_count?: number;
      next_attempt_at?: string;
      lease_token?: string | null;
      lease_expires_at?: string | null;
      last_error_code?: string | null;
      processed_at?: string | null;
    };
    Update: {
      id?: string;
      org_id?: string;
      envelope_sha256?: string;
      payload?: Json;
      received_at?: string;
      status?: string;
      attempt_count?: number;
      next_attempt_at?: string;
      lease_token?: string | null;
      lease_expires_at?: string | null;
      last_error_code?: string | null;
      processed_at?: string | null;
    };
    Relationships: [];
  };
  dialpad_voice_intents: {
    Row: {
      id: string;
      org_id: string;
      actor_user_id: string;
      property_id: string;
      assignment_episode_id: string | null;
      binding_token_hash: string;
      dialpad_user_id: string;
      destination_e164: string;
      caller_id_e164: string;
      client_idempotency_key: string;
      status: string;
      provider_call_id: string | null;
      last_error_code: string | null;
      created_at: string;
      updated_at: string;
    };
    Insert: {
      id?: string;
      org_id: string;
      actor_user_id: string;
      property_id: string;
      assignment_episode_id?: string | null;
      binding_token_hash: string;
      dialpad_user_id: string;
      destination_e164: string;
      caller_id_e164: string;
      client_idempotency_key: string;
      status?: string;
      provider_call_id?: string | null;
      last_error_code?: string | null;
      created_at?: string;
      updated_at?: string;
    };
    Update: {
      id?: string;
      org_id?: string;
      actor_user_id?: string;
      property_id?: string;
      assignment_episode_id?: string | null;
      binding_token_hash?: string;
      dialpad_user_id?: string;
      destination_e164?: string;
      caller_id_e164?: string;
      client_idempotency_key?: string;
      status?: string;
      provider_call_id?: string | null;
      last_error_code?: string | null;
      created_at?: string;
      updated_at?: string;
    };
    Relationships: [];
  };
};

// Migration 20260913210933 retains provider_call_id and permits a null legacy ID for Dialpad.
type CallActivity = BaseDatabase["public"]["Tables"]["call_activities"];
export type DialpadCallActivityTable = {
  Row: Omit<CallActivity["Row"], "jitter_attempt_id"> & { jitter_attempt_id: string | null };
  Insert: Omit<CallActivity["Insert"], "jitter_attempt_id"> & { jitter_attempt_id?: string | null };
  Update: Omit<CallActivity["Update"], "jitter_attempt_id"> & { jitter_attempt_id?: string | null };
  Relationships: CallActivity["Relationships"];
};

export type DialpadVoiceDatabase = Omit<BaseDatabase, "public"> & {
  public: Omit<BaseDatabase["public"], "Tables" | "Functions"> & {
    Tables: Omit<BaseDatabase["public"]["Tables"], "call_activities"> & DialpadVoiceTables & { call_activities: DialpadCallActivityTable };
    Functions: BaseDatabase["public"]["Functions"] & {
      fn_record_dialpad_acquisition_call_start: {
        Args: { p_intent_id: string; p_receipt_id: string };
        Returns: Json;
      };
      fn_prepare_dialpad_sequence_pause: { Args: { p_intent_id: string }; Returns: Json };
      fn_dispatch_dialpad_intent: { Args: { p_intent_id: string }; Returns: Json };
      fn_release_dialpad_start: { Args: { p_intent_id: string; p_rejection_http_status?: number | null }; Returns: Json };
      fn_claim_dialpad_recording: {
        Args: { p_org_id: string; p_lease_seconds?: number };
        Returns: DialpadVoiceTables["dialpad_recording_artifacts"]["Row"][];
      };
      fn_defer_dialpad_detail_budget: {
        Args: { p_org_id: string; p_seconds: number };
        Returns: undefined;
      };
      fn_claim_dialpad_voice_events: {
        Args: { p_org_id: string; p_limit?: number; p_lease_seconds?: number };
        Returns: DialpadVoiceTables["dialpad_voice_event_inbox"]["Row"][];
      };
    };
  };
};
