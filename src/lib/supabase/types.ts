export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      agent_details: {
        Row: {
          added_at: string
          brokerage: string | null
          contact_id: string
          license_number: string | null
          org_id: string
          removed_at: string | null
        }
        Insert: {
          added_at?: string
          brokerage?: string | null
          contact_id: string
          license_number?: string | null
          org_id?: string
          removed_at?: string | null
        }
        Update: {
          added_at?: string
          brokerage?: string | null
          contact_id?: string
          license_number?: string | null
          org_id?: string
          removed_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "agent_details_contact_org_fkey"
            columns: ["contact_id", "org_id"]
            isOneToOne: true
            referencedRelation: "contacts"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "agent_details_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: true
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_details_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_disposition_reviews: {
        Row: {
          ai_reason: string
          conversation_id: string
          created_at: string
          disposition: string
          id: string
          org_id: string
          property_id: string
          resolved_at: string | null
          reviewed_by: string | null
          source_inbound_message_id: string
          status: string
          superseded_reason: string | null
        }
        Insert: {
          ai_reason: string
          conversation_id: string
          created_at?: string
          disposition: string
          id?: string
          org_id: string
          property_id: string
          resolved_at?: string | null
          reviewed_by?: string | null
          source_inbound_message_id: string
          status?: string
          superseded_reason?: string | null
        }
        Update: {
          ai_reason?: string
          conversation_id?: string
          created_at?: string
          disposition?: string
          id?: string
          org_id?: string
          property_id?: string
          resolved_at?: string | null
          reviewed_by?: string | null
          source_inbound_message_id?: string
          status?: string
          superseded_reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_disposition_reviews_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_disposition_reviews_property_org_fkey"
            columns: ["property_id", "org_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "ai_disposition_reviews_source_inbound_message_id_fkey"
            columns: ["source_inbound_message_id"]
            isOneToOne: true
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_responder_configs: {
        Row: {
          active: boolean
          business_hours_only: boolean
          created_at: string
          created_by: string | null
          escalation_keywords: string[]
          id: string
          max_turns: number
          min_confidence: number
          model: string
          org_id: string
          reply_delay_max_seconds: number
          reply_delay_min_seconds: number
          system_prompt: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          business_hours_only?: boolean
          created_at?: string
          created_by?: string | null
          escalation_keywords?: string[]
          id?: string
          max_turns?: number
          min_confidence?: number
          model?: string
          org_id: string
          reply_delay_max_seconds?: number
          reply_delay_min_seconds?: number
          system_prompt: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          business_hours_only?: boolean
          created_at?: string
          created_by?: string | null
          escalation_keywords?: string[]
          id?: string
          max_turns?: number
          min_confidence?: number
          model?: string
          org_id?: string
          reply_delay_max_seconds?: number
          reply_delay_min_seconds?: number
          system_prompt?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_responder_configs_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_response_claims: {
        Row: {
          claimed_at: string
          completed_at: string | null
          contact_id: string | null
          conversation_id: string | null
          created_at: string
          error_message: string | null
          id: string
          inbound_intent_id: string | null
          inbound_message_id: string | null
          lease_expires_at: string
          org_id: string
          outcome: string | null
          outbound_message_id: string | null
          property_id: string | null
          response_kind: string
          status: string
          updated_at: string
        }
        Insert: {
          claimed_at?: string
          completed_at?: string | null
          contact_id?: string | null
          conversation_id?: string | null
          created_at?: string
          error_message?: string | null
          id?: string
          inbound_intent_id?: string | null
          inbound_message_id?: string | null
          lease_expires_at?: string
          org_id: string
          outcome?: string | null
          outbound_message_id?: string | null
          property_id?: string | null
          response_kind?: string
          status?: string
          updated_at?: string
        }
        Update: {
          claimed_at?: string
          completed_at?: string | null
          contact_id?: string | null
          conversation_id?: string | null
          created_at?: string
          error_message?: string | null
          id?: string
          inbound_intent_id?: string | null
          inbound_message_id?: string | null
          lease_expires_at?: string
          org_id?: string
          outcome?: string | null
          outbound_message_id?: string | null
          property_id?: string | null
          response_kind?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_response_claims_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_response_claims_inbound_intent_id_fkey"
            columns: ["inbound_intent_id"]
            isOneToOne: false
            referencedRelation: "sms_inbound_intents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_response_claims_inbound_message_id_fkey"
            columns: ["inbound_message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_response_claims_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_response_claims_outbound_message_id_fkey"
            columns: ["outbound_message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_response_claims_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      call_activities: {
        Row: {
          contact_id: string | null
          created_at: string
          dialer_batch_item_id: string | null
          disposition: string | null
          do_not_call_requested: boolean
          duration_seconds: number | null
          ended_at: string | null
          error_code: string | null
          error_message: string | null
          id: string
          jitter_attempt_id: string
          jitter_session_id: string | null
          operator_user_id: string | null
          org_id: string
          outcome: string | null
          property_id: string | null
          provider: string
          provider_call_id: string | null
          raw_event_count: number
          recording_status: string
          direction: string
          notes: string | null
          recording_path: string | null
          phone_e164: string | null
          started_at: string | null
          summary_status: string
          transcript_status: string
          updated_at: string
          wrap_token: string | null
        }
        Insert: {
          contact_id: string | null
          created_at?: string
          dialer_batch_item_id?: string | null
          disposition?: string | null
          do_not_call_requested?: boolean
          duration_seconds?: number | null
          ended_at?: string | null
          error_code?: string | null
          error_message?: string | null
          id?: string
          jitter_attempt_id: string
          jitter_session_id?: string | null
          operator_user_id?: string | null
          org_id: string
          outcome?: string | null
          property_id?: string | null
          provider?: string
          provider_call_id?: string | null
          raw_event_count?: number
          recording_status?: string
          direction?: string
          notes?: string | null
          recording_path?: string | null
          phone_e164?: string | null
          started_at?: string | null
          summary_status?: string
          transcript_status?: string
          updated_at?: string
          wrap_token?: string | null
        }
        Update: {
          contact_id?: string | null
          created_at?: string
          dialer_batch_item_id?: string | null
          disposition?: string | null
          do_not_call_requested?: boolean
          duration_seconds?: number | null
          ended_at?: string | null
          error_code?: string | null
          error_message?: string | null
          id?: string
          jitter_attempt_id?: string
          jitter_session_id?: string | null
          operator_user_id?: string | null
          org_id?: string
          outcome?: string | null
          property_id?: string | null
          provider?: string
          provider_call_id?: string | null
          raw_event_count?: number
          recording_status?: string
          direction?: string
          notes?: string | null
          recording_path?: string | null
          phone_e164?: string | null
          started_at?: string | null
          summary_status?: string
          transcript_status?: string
          updated_at?: string
          wrap_token?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "call_activities_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_activities_dialer_batch_item_id_fkey"
            columns: ["dialer_batch_item_id"]
            isOneToOne: false
            referencedRelation: "dialer_batch_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_activities_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_activities_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      call_recordings: {
        Row: {
          call_activity_id: string
          created_at: string
          duration_seconds: number | null
          error_code: string | null
          error_message: string | null
          id: string
          status: string
          storage_path: string | null
          updated_at: string
        }
        Insert: {
          call_activity_id: string
          created_at?: string
          duration_seconds?: number | null
          error_code?: string | null
          error_message?: string | null
          id?: string
          status?: string
          storage_path?: string | null
          updated_at?: string
        }
        Update: {
          call_activity_id?: string
          created_at?: string
          duration_seconds?: number | null
          error_code?: string | null
          error_message?: string | null
          id?: string
          status?: string
          storage_path?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "call_recordings_call_activity_id_fkey"
            columns: ["call_activity_id"]
            isOneToOne: false
            referencedRelation: "call_activities"
            referencedColumns: ["id"]
          },
        ]
      }
      call_transcripts: {
        Row: {
          call_activity_id: string
          created_at: string
          error_code: string | null
          error_message: string | null
          id: string
          language: string | null
          status: string
          summary: string | null
          summary_error_code: string | null
          summary_error_message: string | null
          summary_status: string
          text: string | null
          updated_at: string
        }
        Insert: {
          call_activity_id: string
          created_at?: string
          error_code?: string | null
          error_message?: string | null
          id?: string
          language?: string | null
          status?: string
          summary?: string | null
          summary_error_code?: string | null
          summary_error_message?: string | null
          summary_status?: string
          text?: string | null
          updated_at?: string
        }
        Update: {
          call_activity_id?: string
          created_at?: string
          error_code?: string | null
          error_message?: string | null
          id?: string
          language?: string | null
          status?: string
          summary?: string | null
          summary_error_code?: string | null
          summary_error_message?: string | null
          summary_status?: string
          text?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "call_transcripts_call_activity_id_fkey"
            columns: ["call_activity_id"]
            isOneToOne: false
            referencedRelation: "call_activities"
            referencedColumns: ["id"]
          },
        ]
      }
      campaigns: {
        Row: {
          archived_at: string | null
          audience_snapshot: Json | null
          body: string | null
          channel: string
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          name: string
          org_id: string
          pace_seconds: number | null
          provider_campaign_external_id: string | null
          provider_campaign_name: string | null
          sender_number: string | null
          sender_provider: string | null
          skip_if_contacted: boolean
          status: string
          template_category: string | null
          updated_at: string
        }
        Insert: {
          archived_at?: string | null
          audience_snapshot?: Json | null
          body?: string | null
          channel?: string
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          name: string
          org_id: string
          pace_seconds?: number | null
          provider_campaign_external_id?: string | null
          provider_campaign_name?: string | null
          sender_number?: string | null
          sender_provider?: string | null
          skip_if_contacted?: boolean
          status?: string
          template_category?: string | null
          updated_at?: string
        }
        Update: {
          archived_at?: string | null
          audience_snapshot?: Json | null
          body?: string | null
          channel?: string
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          name?: string
          org_id?: string
          pace_seconds?: number | null
          provider_campaign_external_id?: string | null
          provider_campaign_name?: string | null
          sender_number?: string | null
          sender_provider?: string | null
          skip_if_contacted?: boolean
          status?: string
          template_category?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "campaigns_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      campaign_delivery_settings: {
        Row: {
          campaign_id: string
          created_at: string
          from_address: string
          id: string
          org_id: string
          provider: string
          provider_campaign_id: string | null
          provider_campaign_name: string | null
          sender_number: string
          updated_at: string
        }
        Insert: {
          campaign_id: string
          created_at?: string
          from_address: string
          id?: string
          org_id: string
          provider: string
          provider_campaign_id?: string | null
          provider_campaign_name?: string | null
          sender_number: string
          updated_at?: string
        }
        Update: {
          campaign_id?: string
          created_at?: string
          from_address?: string
          id?: string
          org_id?: string
          provider?: string
          provider_campaign_id?: string | null
          provider_campaign_name?: string | null
          sender_number?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "campaign_delivery_settings_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: true
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_delivery_settings_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      campaign_recipients: {
        Row: {
          campaign_id: string
          contact_id: string | null
          created_at: string
          id: string
          property_id: string
        }
        Insert: {
          campaign_id: string
          contact_id?: string | null
          created_at?: string
          id?: string
          property_id: string
        }
        Update: {
          campaign_id?: string
          contact_id?: string | null
          created_at?: string
          id?: string
          property_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "campaign_recipients_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_recipients_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_recipients_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      cass_cache: {
        Row: {
          cass_response: Json
          org_id: string
          raw_address: string
          verified_at: string
        }
        Insert: {
          cass_response: Json
          org_id?: string
          raw_address: string
          verified_at?: string
        }
        Update: {
          cass_response?: Json
          org_id?: string
          raw_address?: string
          verified_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "cass_cache_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      cass_job_authorizations: {
        Row: {
          authorized_at: string
          job_id: string
          org_id: string
          property_ids: string[]
          purpose: string
          request_key: string
          requested_by: string | null
          source_job_id: string | null
          start_claim_token: string | null
          start_claimed_at: string | null
        }
        Insert: {
          authorized_at?: string
          job_id: string
          org_id: string
          property_ids: string[]
          purpose: string
          request_key: string
          requested_by?: string | null
          source_job_id?: string | null
          start_claim_token?: string | null
          start_claimed_at?: string | null
        }
        Update: {
          authorized_at?: string
          job_id?: string
          org_id?: string
          property_ids?: string[]
          purpose?: string
          request_key?: string
          requested_by?: string | null
          source_job_id?: string | null
          start_claim_token?: string | null
          start_claimed_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cass_job_authorizations_job_org_fkey"
            columns: ["job_id", "org_id"]
            isOneToOne: true
            referencedRelation: "jobs"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "cass_job_authorizations_source_org_fkey"
            columns: ["source_job_id", "org_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id", "org_id"]
          },
        ]
      }
      cass_property_lookup_outcomes: {
        Row: {
          attempt_count: number
          completed_at: string | null
          created_at: string
          error_message: string | null
          job_id: string
          org_id: string
          outcome: string | null
          property_id: string | null
          property_key: string
          provider_id: string
          result_payload: Json | null
          state: string
        }
        Insert: {
          attempt_count?: number
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          job_id: string
          org_id: string
          outcome?: string | null
          property_id?: string | null
          property_key: string
          provider_id: string
          result_payload?: Json | null
          state: string
        }
        Update: {
          attempt_count?: number
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          job_id?: string
          org_id?: string
          outcome?: string | null
          property_id?: string | null
          property_key?: string
          provider_id?: string
          result_payload?: Json | null
          state?: string
        }
        Relationships: [
          {
            foreignKeyName: "cass_property_lookup_outcomes_job_org_fkey"
            columns: ["job_id", "org_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "cass_property_lookup_outcomes_property_org_fkey"
            columns: ["property_id", "org_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id", "org_id"]
          },
        ]
      }
      consent_events: {
        Row: {
          channel: string
          contact_id: string
          created_at: string
          event_type: string
          id: string
          idempotency_key: string | null
          occurred_at: string
          org_id: string
          source: string | null
          source_detail: Json | null
        }
        Insert: {
          channel: string
          contact_id: string
          created_at?: string
          event_type: string
          id?: string
          idempotency_key?: string | null
          occurred_at?: string
          org_id?: string
          source?: string | null
          source_detail?: Json | null
        }
        Update: {
          channel?: string
          contact_id?: string
          created_at?: string
          event_type?: string
          id?: string
          idempotency_key?: string | null
          occurred_at?: string
          org_id?: string
          source?: string | null
          source_detail?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "consent_events_contact_org_fkey"
            columns: ["contact_id", "org_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "consent_events_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "consent_events_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      contacts: {
        Row: {
          contact_type: string
          created_at: string
          do_not_contact: boolean
          email: string | null
          email_opted_out: boolean
          email_opted_out_at: string | null
          entity_name: string | null
          first_name: string | null
          id: string
          last_name: string | null
          notes: string | null
          org_id: string
          phone_1: string | null
          phone_1_type: string
          phone_2: string | null
          phone_2_type: string
          phone_3: string | null
          phone_3_type: string
          sms_opted_out: boolean
          sms_opted_out_at: string | null
        }
        Insert: {
          contact_type?: string
          created_at?: string
          do_not_contact?: boolean
          email?: string | null
          email_opted_out?: boolean
          email_opted_out_at?: string | null
          entity_name?: string | null
          first_name?: string | null
          id?: string
          last_name?: string | null
          notes?: string | null
          org_id?: string
          phone_1?: string | null
          phone_1_type?: string
          phone_2?: string | null
          phone_2_type?: string
          phone_3?: string | null
          phone_3_type?: string
          sms_opted_out?: boolean
          sms_opted_out_at?: string | null
        }
        Update: {
          contact_type?: string
          created_at?: string
          do_not_contact?: boolean
          email?: string | null
          email_opted_out?: boolean
          email_opted_out_at?: string | null
          entity_name?: string | null
          first_name?: string | null
          id?: string
          last_name?: string | null
          notes?: string | null
          org_id?: string
          phone_1?: string | null
          phone_1_type?: string
          phone_2?: string | null
          phone_2_type?: string
          phone_3?: string | null
          phone_3_type?: string
          sms_opted_out?: boolean
          sms_opted_out_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "contacts_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      counties: {
        Row: {
          created_at: string
          fips_code: string | null
          id: string
          market: string
          name: string
          state: string
        }
        Insert: {
          created_at?: string
          fips_code?: string | null
          id?: string
          market: string
          name: string
          state: string
        }
        Update: {
          created_at?: string
          fips_code?: string | null
          id?: string
          market?: string
          name?: string
          state?: string
        }
        Relationships: []
      }
      csv_import_consent_outcomes: {
        Row: {
          consent_event_id: string
          contact_id: string
          created_at: string
          job_id: string
          org_id: string
        }
        Insert: {
          consent_event_id: string
          contact_id: string
          created_at?: string
          job_id: string
          org_id: string
        }
        Update: {
          consent_event_id?: string
          contact_id?: string
          created_at?: string
          job_id?: string
          org_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "csv_import_consent_outcomes_consent_event_id_fkey"
            columns: ["consent_event_id"]
            isOneToOne: true
            referencedRelation: "consent_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "csv_import_consent_outcomes_contact_org_fkey"
            columns: ["contact_id", "org_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "csv_import_consent_outcomes_job_org_fkey"
            columns: ["job_id", "org_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id", "org_id"]
          },
        ]
      }
      csv_import_job_provenance: {
        Row: {
          classify_line_types: boolean
          county_id: string
          created_at: string
          csv_import_id: string
          dataset_sha256: string
          dataset_version: number
          expected_dnc_rows: number
          expected_total_rows: number
          job_id: string
          list_id: string | null
          list_name: string | null
          list_resolution_error: string | null
          mapping: Json
          market: string
          org_id: string
          request_cass: boolean
          requested_by: string | null
          review_contract_sha256: string
          sequence_id: string | null
          sms_consent: boolean
          source: string
          storage_path: string
        }
        Insert: {
          classify_line_types?: boolean
          county_id: string
          created_at?: string
          csv_import_id: string
          dataset_sha256: string
          dataset_version: number
          expected_dnc_rows?: number
          expected_total_rows: number
          job_id: string
          list_id?: string | null
          list_name?: string | null
          list_resolution_error?: string | null
          mapping: Json
          market: string
          org_id: string
          request_cass?: boolean
          requested_by?: string | null
          review_contract_sha256: string
          sequence_id?: string | null
          sms_consent?: boolean
          source: string
          storage_path: string
        }
        Update: {
          classify_line_types?: boolean
          county_id?: string
          created_at?: string
          csv_import_id?: string
          dataset_sha256?: string
          dataset_version?: number
          expected_dnc_rows?: number
          expected_total_rows?: number
          job_id?: string
          list_id?: string | null
          list_name?: string | null
          list_resolution_error?: string | null
          mapping?: Json
          market?: string
          org_id?: string
          request_cass?: boolean
          requested_by?: string | null
          review_contract_sha256?: string
          sequence_id?: string | null
          sms_consent?: boolean
          source?: string
          storage_path?: string
        }
        Relationships: [
          {
            foreignKeyName: "csv_import_job_provenance_import_org_fkey"
            columns: ["csv_import_id", "org_id"]
            isOneToOne: false
            referencedRelation: "csv_imports"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "csv_import_job_provenance_job_org_fkey"
            columns: ["job_id", "org_id"]
            isOneToOne: true
            referencedRelation: "jobs"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "csv_import_job_provenance_list_fkey"
            columns: ["list_id"]
            isOneToOne: false
            referencedRelation: "lists"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "csv_import_job_provenance_sequence_fkey"
            columns: ["sequence_id"]
            isOneToOne: false
            referencedRelation: "sequences"
            referencedColumns: ["id"]
          },
        ]
      }
      csv_import_line_type_outcomes: {
        Row: {
          claimed_at: string
          completed_at: string | null
          created_at: string
          job_id: string
          job_retry_count: number
          last_error: string | null
          line_type: string | null
          lookup_attempts: number
          org_id: string
          outcome: string | null
          phone_e164: string
          provider_http_status: number | null
          state: string
        }
        Insert: {
          claimed_at?: string
          completed_at?: string | null
          created_at?: string
          job_id: string
          job_retry_count: number
          last_error?: string | null
          line_type?: string | null
          lookup_attempts?: number
          org_id: string
          outcome?: string | null
          phone_e164: string
          provider_http_status?: number | null
          state: string
        }
        Update: {
          claimed_at?: string
          completed_at?: string | null
          created_at?: string
          job_id?: string
          job_retry_count?: number
          last_error?: string | null
          line_type?: string | null
          lookup_attempts?: number
          org_id?: string
          outcome?: string | null
          phone_e164?: string
          provider_http_status?: number | null
          state?: string
        }
        Relationships: [
          {
            foreignKeyName: "csv_import_line_type_outcomes_job_org_fkey"
            columns: ["job_id", "org_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id", "org_id"]
          },
        ]
      }
      csv_import_row_outcomes: {
        Row: {
          created_at: string
          csv_import_id: string
          job_id: string
          org_id: string
          original_outcome: string
          property_id: string
          source_row_index: number
        }
        Insert: {
          created_at?: string
          csv_import_id: string
          job_id: string
          org_id: string
          original_outcome: string
          property_id: string
          source_row_index: number
        }
        Update: {
          created_at?: string
          csv_import_id?: string
          job_id?: string
          org_id?: string
          original_outcome?: string
          property_id?: string
          source_row_index?: number
        }
        Relationships: [
          {
            foreignKeyName: "csv_import_row_outcomes_import_org_fkey"
            columns: ["csv_import_id", "org_id"]
            isOneToOne: false
            referencedRelation: "csv_imports"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "csv_import_row_outcomes_job_org_fkey"
            columns: ["job_id", "org_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "csv_import_row_outcomes_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      csv_imports: {
        Row: {
          county_id: string | null
          created_at: string
          dataset_sha256: string | null
          dataset_version: number | null
          dnc_rows: number
          errors: Json | null
          failed_rows: number
          filename: string | null
          id: string
          inserted_agents: number
          inserted_homeowners: number
          inserted_properties: number
          market: string | null
          org_id: string
          skipped_duplicates: number
          source: string | null
          storage_path: string | null
          total_rows: number
          user_id: string | null
        }
        Insert: {
          county_id?: string | null
          created_at?: string
          dataset_sha256?: string | null
          dataset_version?: number | null
          dnc_rows?: number
          errors?: Json | null
          failed_rows?: number
          filename?: string | null
          id?: string
          inserted_agents?: number
          inserted_homeowners?: number
          inserted_properties?: number
          market?: string | null
          org_id?: string
          skipped_duplicates?: number
          source?: string | null
          storage_path?: string | null
          total_rows?: number
          user_id?: string | null
        }
        Update: {
          county_id?: string | null
          created_at?: string
          dataset_sha256?: string | null
          dataset_version?: number | null
          dnc_rows?: number
          errors?: Json | null
          failed_rows?: number
          filename?: string | null
          id?: string
          inserted_agents?: number
          inserted_homeowners?: number
          inserted_properties?: number
          market?: string | null
          org_id?: string
          skipped_duplicates?: number
          source?: string | null
          storage_path?: string | null
          total_rows?: number
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "csv_imports_county_id_fkey"
            columns: ["county_id"]
            isOneToOne: false
            referencedRelation: "counties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "csv_imports_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      dialer_batch_items: {
        Row: {
          batch_id: string
          calling_window_end_hour: number
          calling_window_start_hour: number
          contact_id: string
          created_at: string
          id: string
          last_call_activity_id: string | null
          phone_e164: string
          phone_label: string
          property_id: string
          sort_order: number
          state: string
          status: string
          timezone: string
          updated_at: string
        }
        Insert: {
          batch_id: string
          calling_window_end_hour?: number
          calling_window_start_hour?: number
          contact_id: string
          created_at?: string
          id?: string
          last_call_activity_id?: string | null
          phone_e164: string
          phone_label: string
          property_id: string
          sort_order?: number
          state: string
          status?: string
          timezone: string
          updated_at?: string
        }
        Update: {
          batch_id?: string
          calling_window_end_hour?: number
          calling_window_start_hour?: number
          contact_id?: string
          created_at?: string
          id?: string
          last_call_activity_id?: string | null
          phone_e164?: string
          phone_label?: string
          property_id?: string
          sort_order?: number
          state?: string
          status?: string
          timezone?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "dialer_batch_items_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "dialer_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dialer_batch_items_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dialer_batch_items_last_call_activity_id_fkey"
            columns: ["last_call_activity_id"]
            isOneToOne: false
            referencedRelation: "call_activities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dialer_batch_items_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      dialer_batches: {
        Row: {
          claim_generation: number
          claimed_at: string | null
          completed_at: string | null
          created_at: string
          created_by_user_id: string | null
          id: string
          jitter_session_id: string | null
          org_id: string
          source_kind: string
          source_meta: Json
          status: string
          title: string | null
          updated_at: string
        }
        Insert: {
          claim_generation?: number
          claimed_at?: string | null
          completed_at?: string | null
          created_at?: string
          created_by_user_id?: string | null
          id?: string
          jitter_session_id?: string | null
          org_id: string
          source_kind: string
          source_meta?: Json
          status?: string
          title?: string | null
          updated_at?: string
        }
        Update: {
          claim_generation?: number
          claimed_at?: string | null
          completed_at?: string | null
          created_at?: string
          created_by_user_id?: string | null
          id?: string
          jitter_session_id?: string | null
          org_id?: string
          source_kind?: string
          source_meta?: Json
          status?: string
          title?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "dialer_batches_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      fips_codes: {
        Row: {
          county_name: string
          fips_code: string
          state_code: string
        }
        Insert: {
          county_name: string
          fips_code: string
          state_code: string
        }
        Update: {
          county_name?: string
          fips_code?: string
          state_code?: string
        }
        Relationships: []
      }
      homeowner_details: {
        Row: {
          added_at: string
          contact_id: string
          mailing_address: string | null
          mailing_city: string | null
          mailing_state: string | null
          mailing_zip: string | null
          org_id: string
          removed_at: string | null
        }
        Insert: {
          added_at?: string
          contact_id: string
          mailing_address?: string | null
          mailing_city?: string | null
          mailing_state?: string | null
          mailing_zip?: string | null
          org_id?: string
          removed_at?: string | null
        }
        Update: {
          added_at?: string
          contact_id?: string
          mailing_address?: string | null
          mailing_city?: string | null
          mailing_state?: string | null
          mailing_zip?: string | null
          org_id?: string
          removed_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "homeowner_details_contact_org_fkey"
            columns: ["contact_id", "org_id"]
            isOneToOne: true
            referencedRelation: "contacts"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "homeowner_details_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: true
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "homeowner_details_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      job_items: {
        Row: {
          contact_id: string | null
          compliance_locked: boolean
          error_class: string | null
          error_message: string | null
          id: string
          input_payload: Json | null
          item_key: string | null
          job_id: string
          message_id: string | null
          org_id: string
          output_payload: Json | null
          processed_at: string | null
          property_id: string | null
          retry_count: number
          source_row_index: number | null
          status: string
        }
        Insert: {
          contact_id?: string | null
          compliance_locked?: boolean
          error_class?: string | null
          error_message?: string | null
          id?: string
          input_payload?: Json | null
          item_key?: string | null
          job_id: string
          message_id?: string | null
          org_id?: string
          output_payload?: Json | null
          processed_at?: string | null
          property_id?: string | null
          retry_count?: number
          source_row_index?: number | null
          status?: string
        }
        Update: {
          contact_id?: string | null
          compliance_locked?: boolean
          error_class?: string | null
          error_message?: string | null
          id?: string
          input_payload?: Json | null
          item_key?: string | null
          job_id?: string
          message_id?: string | null
          org_id?: string
          output_payload?: Json | null
          processed_at?: string | null
          property_id?: string | null
          retry_count?: number
          source_row_index?: number | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "job_items_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_items_job_org_fkey"
            columns: ["job_id", "org_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "job_items_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_items_property_org_fkey"
            columns: ["property_id", "org_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id", "org_id"]
          },
        ]
      }
      jobs: {
        Row: {
          completed_at: string | null
          created_at: string
          created_by: string | null
          description: string | null
          error_class: string | null
          error_message: string | null
          failed_items: number
          id: string
          idempotency_key: string | null
          input_params: Json | null
          max_retries: number
          org_id: string
          parent_job_id: string | null
          processed_items: number
          provider: string | null
          provider_run_id: string | null
          provider_webhook_secret: string | null
          related_import_id: string | null
          result_summary: Json | null
          retry_count: number
          started_at: string | null
          status: string
          succeeded_items: number
          title: string | null
          total_items: number
          type: string
          worker_heartbeat_at: string | null
          workflow_claim_token: string | null
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          error_class?: string | null
          error_message?: string | null
          failed_items?: number
          id?: string
          idempotency_key?: string | null
          input_params?: Json | null
          max_retries?: number
          org_id?: string
          parent_job_id?: string | null
          processed_items?: number
          provider?: string | null
          provider_run_id?: string | null
          provider_webhook_secret?: string | null
          related_import_id?: string | null
          result_summary?: Json | null
          retry_count?: number
          started_at?: string | null
          status?: string
          succeeded_items?: number
          title?: string | null
          total_items?: number
          type: string
          worker_heartbeat_at?: string | null
          workflow_claim_token?: string | null
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          error_class?: string | null
          error_message?: string | null
          failed_items?: number
          id?: string
          idempotency_key?: string | null
          input_params?: Json | null
          max_retries?: number
          org_id?: string
          parent_job_id?: string | null
          processed_items?: number
          provider?: string | null
          provider_run_id?: string | null
          provider_webhook_secret?: string | null
          related_import_id?: string | null
          result_summary?: Json | null
          retry_count?: number
          started_at?: string | null
          status?: string
          succeeded_items?: number
          title?: string | null
          total_items?: number
          type?: string
          worker_heartbeat_at?: string | null
          workflow_claim_token?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "jobs_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_parent_job_id_fkey"
            columns: ["parent_job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_related_import_id_fkey"
            columns: ["related_import_id"]
            isOneToOne: false
            referencedRelation: "csv_imports"
            referencedColumns: ["id"]
          },
        ]
      }
      lead_events: {
        Row: {
          actor_id: string | null
          actor_type: string
          created_at: string
          event_type: string
          id: string
          org_id: string
          payload: Json
          property_id: string
          source_id: string | null
          source_type: string | null
        }
        Insert: {
          actor_id?: string | null
          actor_type: string
          created_at?: string
          event_type: string
          id?: string
          org_id: string
          payload?: Json
          property_id: string
          source_id?: string | null
          source_type?: string | null
        }
        Update: {
          actor_id?: string | null
          actor_type?: string
          created_at?: string
          event_type?: string
          id?: string
          org_id?: string
          payload?: Json
          property_id?: string
          source_id?: string | null
          source_type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "lead_events_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_events_property_org_fkey"
            columns: ["property_id", "org_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id", "org_id"]
          },
        ]
      }
      lead_notes: {
        Row: {
          author_user_id: string | null
          body: string
          created_at: string
          id: string
          org_id: string
          property_id: string
        }
        Insert: {
          author_user_id?: string | null
          body: string
          created_at?: string
          id?: string
          org_id: string
          property_id: string
        }
        Update: {
          author_user_id?: string | null
          body?: string
          created_at?: string
          id?: string
          org_id?: string
          property_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "lead_notes_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_notes_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      lists: {
        Row: {
          archived_at: string | null
          color: string | null
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          name: string
          org_id: string
          system_managed: boolean
        }
        Insert: {
          archived_at?: string | null
          color?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          name: string
          org_id?: string
          system_managed?: boolean
        }
        Update: {
          archived_at?: string | null
          color?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          name?: string
          org_id?: string
          system_managed?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "lists_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      memberships: {
        Row: {
          access_expires_at: string | null
          access_status: string
          created_at: string
          deletion_operation_id: string | null
          deletion_prepared_at: string | null
          hugo_config: Json
          id: string
          org_id: string
          role: string
          user_id: string
        }
        Insert: {
          access_expires_at?: string | null
          access_status?: string
          created_at?: string
          deletion_operation_id?: string | null
          deletion_prepared_at?: string | null
          hugo_config?: Json
          id?: string
          org_id: string
          role?: string
          user_id: string
        }
        Update: {
          access_expires_at?: string | null
          access_status?: string
          created_at?: string
          deletion_operation_id?: string | null
          deletion_prepared_at?: string | null
          hugo_config?: Json
          id?: string
          org_id?: string
          role?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "memberships_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      messages: {
        Row: {
          attributed_outbound_message_id: string | null
          body: string
          campaign_id: string | null
          channel: string
          contact_id: string | null
          conversation_id: string | null
          created_at: string
          delivered_at: string | null
          direction: string
          dismissed_at: string | null
          error_message: string | null
          external_id: string | null
          failed_at: string | null
          from_address: string | null
          id: string
          inbound_intent_id: string | null
          metadata: Json | null
          org_id: string
          property_id: string | null
          provider: string | null
          read_at: string | null
          scheduled_for: string | null
          sent_at: string | null
          status: string
          subject: string | null
          to_address: string | null
        }
        Insert: {
          attributed_outbound_message_id?: string | null
          body: string
          campaign_id?: string | null
          channel: string
          contact_id?: string | null
          conversation_id?: string | null
          created_at?: string
          delivered_at?: string | null
          direction: string
          dismissed_at?: string | null
          error_message?: string | null
          external_id?: string | null
          failed_at?: string | null
          from_address?: string | null
          id?: string
          inbound_intent_id?: string | null
          metadata?: Json | null
          org_id?: string
          property_id?: string | null
          provider?: string | null
          read_at?: string | null
          scheduled_for?: string | null
          sent_at?: string | null
          status?: string
          subject?: string | null
          to_address?: string | null
        }
        Update: {
          attributed_outbound_message_id?: string | null
          body?: string
          campaign_id?: string | null
          channel?: string
          contact_id?: string | null
          conversation_id?: string | null
          created_at?: string
          delivered_at?: string | null
          direction?: string
          dismissed_at?: string | null
          error_message?: string | null
          external_id?: string | null
          failed_at?: string | null
          from_address?: string | null
          id?: string
          inbound_intent_id?: string | null
          metadata?: Json | null
          org_id?: string
          property_id?: string | null
          provider?: string | null
          read_at?: string | null
          scheduled_for?: string | null
          sent_at?: string | null
          status?: string
          subject?: string | null
          to_address?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "messages_attributed_outbound_message_id_fkey"
            columns: ["attributed_outbound_message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_inbound_intent_id_fkey"
            columns: ["inbound_intent_id"]
            isOneToOne: false
            referencedRelation: "sms_inbound_intents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      dashboard_snapshots: {
        Row: {
          captured_at: string
          payload: Json
          snapshot_key: string
        }
        Insert: {
          captured_at: string
          payload: Json
          snapshot_key: string
        }
        Update: {
          captured_at?: string
          payload?: Json
          snapshot_key?: string
        }
        Relationships: []
      }
      metric_snapshots: {
        Row: {
          captured_at: string
          captured_on: string
          denominator: number
          id: string
          metric_key: string
          numerator: number
        }
        Insert: {
          captured_at?: string
          captured_on?: string
          denominator: number
          id?: string
          metric_key: string
          numerator: number
        }
        Update: {
          captured_at?: string
          captured_on?: string
          denominator?: number
          id?: string
          metric_key?: string
          numerator?: number
        }
        Relationships: []
      }
      sms_phone_suppressions: {
        Row: {
          channel: string
          created_at: string
          first_contact_id: string | null
          id: string
          org_id: string
          phone_e164: string
          provider: string | null
          source: string
          source_detail: Json | null
          suppressed_at: string
          updated_at: string
        }
        Insert: {
          channel?: string
          created_at?: string
          first_contact_id?: string | null
          id?: string
          org_id: string
          phone_e164: string
          provider?: string | null
          source: string
          source_detail?: Json | null
          suppressed_at?: string
          updated_at?: string
        }
        Update: {
          channel?: string
          created_at?: string
          first_contact_id?: string | null
          id?: string
          org_id?: string
          phone_e164?: string
          provider?: string | null
          source?: string
          source_detail?: Json | null
          suppressed_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sms_phone_suppressions_first_contact_id_fkey"
            columns: ["first_contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sms_phone_suppressions_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          body: string | null
          created_at: string
          entity_id: string
          entity_type: string
          event_type: string
          id: string
          org_id: string
          read_at: string | null
          title: string
          user_id: string
        }
        Insert: {
          body?: string | null
          created_at?: string
          entity_id: string
          entity_type: string
          event_type: string
          id?: string
          org_id: string
          read_at?: string | null
          title: string
          user_id: string
        }
        Update: {
          body?: string | null
          created_at?: string
          entity_id?: string
          entity_type?: string
          event_type?: string
          id?: string
          org_id?: string
          read_at?: string | null
          title?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          created_at: string
          id: string
          name: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
        }
        Relationships: []
      }
      properties: {
        Row: {
          absentee_flag: boolean | null
          address: string
          address_normalized: string | null
          agent_contact_id: string | null
          ai_responder_disabled: boolean
          apn: string | null
          apn_normalized: string | null
          arv: number | null
          assigned_user_id: string | null
          attom_id: string | null
          baths: number | null
          beds: number | null
          cass_raw_response: Json | null
          cass_status: string
          cass_verified_at: string | null
          city: string | null
          county_id: string | null
          created_at: string
          deleted_at: string | null
          distress_flags: string[]
          equity_estimate: number | null
          equity_pct: number | null
          fips_code: string | null
          follow_up_at: string | null
          homeowner_contact_id: string | null
          id: string
          is_dnc_locked: boolean
          is_residential: boolean | null
          is_seasonal: boolean | null
          is_vacant: boolean | null
          last_ai_escalation_at: string | null
          last_ai_escalation_reason: string | null
          lat: number | null
          listing_price: number | null
          lon: number | null
          market: string | null
          mls_number: string | null
          mortgage_balance: number | null
          motivation_level: string | null
          ncoa_verified_at: string | null
          needs_human_attention: boolean
          notes: string | null
          org_id: string
          outreach_dispo: string | null
          owner_moved_at: string | null
          qualified_at: string | null
          qualified_by: string | null
          regrid_id: string | null
          repair_estimate: number | null
          skip_trace_disabled: boolean
          source: string | null
          source_import_id: string | null
          source_imported_at: string | null
          sqft: number | null
          state: string
          status: string
          updated_at: string
          vacant_since: string | null
          year_built: number | null
          zip: string | null
          zpid: string | null
        }
        Insert: {
          absentee_flag?: boolean | null
          address: string
          address_normalized?: string | null
          agent_contact_id?: string | null
          ai_responder_disabled?: boolean
          apn?: string | null
          apn_normalized?: string | null
          arv?: number | null
          assigned_user_id?: string | null
          attom_id?: string | null
          baths?: number | null
          beds?: number | null
          cass_raw_response?: Json | null
          cass_status?: string
          cass_verified_at?: string | null
          city?: string | null
          county_id?: string | null
          created_at?: string
          deleted_at?: string | null
          distress_flags?: string[]
          equity_estimate?: number | null
          equity_pct?: number | null
          fips_code?: string | null
          follow_up_at?: string | null
          homeowner_contact_id?: string | null
          id?: string
          is_dnc_locked?: boolean
          is_residential?: boolean | null
          is_seasonal?: boolean | null
          is_vacant?: boolean | null
          last_ai_escalation_at?: string | null
          last_ai_escalation_reason?: string | null
          lat?: number | null
          listing_price?: number | null
          lon?: number | null
          market?: string | null
          mls_number?: string | null
          mortgage_balance?: number | null
          motivation_level?: string | null
          ncoa_verified_at?: string | null
          needs_human_attention?: boolean
          notes?: string | null
          org_id?: string
          outreach_dispo?: string | null
          owner_moved_at?: string | null
          qualified_at?: string | null
          qualified_by?: string | null
          regrid_id?: string | null
          repair_estimate?: number | null
          skip_trace_disabled?: boolean
          source?: string | null
          source_import_id?: string | null
          source_imported_at?: string | null
          sqft?: number | null
          state: string
          status?: string
          updated_at?: string
          vacant_since?: string | null
          year_built?: number | null
          zip?: string | null
          zpid?: string | null
        }
        Update: {
          absentee_flag?: boolean | null
          address?: string
          address_normalized?: string | null
          agent_contact_id?: string | null
          ai_responder_disabled?: boolean
          apn?: string | null
          apn_normalized?: string | null
          arv?: number | null
          assigned_user_id?: string | null
          attom_id?: string | null
          baths?: number | null
          beds?: number | null
          cass_raw_response?: Json | null
          cass_status?: string
          cass_verified_at?: string | null
          city?: string | null
          county_id?: string | null
          created_at?: string
          deleted_at?: string | null
          distress_flags?: string[]
          equity_estimate?: number | null
          equity_pct?: number | null
          fips_code?: string | null
          follow_up_at?: string | null
          homeowner_contact_id?: string | null
          id?: string
          is_dnc_locked?: boolean
          is_residential?: boolean | null
          is_seasonal?: boolean | null
          is_vacant?: boolean | null
          last_ai_escalation_at?: string | null
          last_ai_escalation_reason?: string | null
          lat?: number | null
          listing_price?: number | null
          lon?: number | null
          market?: string | null
          mls_number?: string | null
          mortgage_balance?: number | null
          motivation_level?: string | null
          ncoa_verified_at?: string | null
          needs_human_attention?: boolean
          notes?: string | null
          org_id?: string
          outreach_dispo?: string | null
          owner_moved_at?: string | null
          qualified_at?: string | null
          qualified_by?: string | null
          regrid_id?: string | null
          repair_estimate?: number | null
          skip_trace_disabled?: boolean
          source?: string | null
          source_import_id?: string | null
          source_imported_at?: string | null
          sqft?: number | null
          state?: string
          status?: string
          updated_at?: string
          vacant_since?: string | null
          year_built?: number | null
          zip?: string | null
          zpid?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "properties_agent_contact_id_fkey"
            columns: ["agent_contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "properties_county_id_fkey"
            columns: ["county_id"]
            isOneToOne: false
            referencedRelation: "counties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "properties_homeowner_contact_id_fkey"
            columns: ["homeowner_contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "properties_source_import_org_fkey"
            columns: ["source_import_id", "org_id"]
            isOneToOne: false
            referencedRelation: "csv_imports"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "properties_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      property_lists: {
        Row: {
          first_added_at: string
          id: string
          last_added_at: string
          last_added_by: string | null
          last_source_import_id: string | null
          list_id: string
          org_id: string
          property_id: string
        }
        Insert: {
          first_added_at?: string
          id?: string
          last_added_at?: string
          last_added_by?: string | null
          last_source_import_id?: string | null
          list_id: string
          org_id?: string
          property_id: string
        }
        Update: {
          first_added_at?: string
          id?: string
          last_added_at?: string
          last_added_by?: string | null
          last_source_import_id?: string | null
          list_id?: string
          org_id?: string
          property_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "property_lists_last_source_import_id_fkey"
            columns: ["last_source_import_id"]
            isOneToOne: false
            referencedRelation: "csv_imports"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "property_lists_list_id_fkey"
            columns: ["list_id"]
            isOneToOne: false
            referencedRelation: "lists"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "property_lists_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "property_lists_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      property_merges: {
        Row: {
          id: string
          keeper_id: string
          loser_id: string
          loser_snapshot: Json
          merged_at: string
          merged_by: string | null
          org_id: string
        }
        Insert: {
          id?: string
          keeper_id: string
          loser_id: string
          loser_snapshot: Json
          merged_at?: string
          merged_by?: string | null
          org_id?: string
        }
        Update: {
          id?: string
          keeper_id?: string
          loser_id?: string
          loser_snapshot?: Json
          merged_at?: string
          merged_by?: string | null
          org_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "property_merges_keeper_id_fkey"
            columns: ["keeper_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "property_merges_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      property_tags: {
        Row: {
          applied_at: string
          applied_by: string | null
          id: string
          org_id: string
          property_id: string
          source: string
          tag_id: string
        }
        Insert: {
          applied_at?: string
          applied_by?: string | null
          id?: string
          org_id?: string
          property_id: string
          source?: string
          tag_id: string
        }
        Update: {
          applied_at?: string
          applied_by?: string | null
          id?: string
          org_id?: string
          property_id?: string
          source?: string
          tag_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "property_tags_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "property_tags_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "property_tags_tag_id_fkey"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "tags"
            referencedColumns: ["id"]
          },
        ]
      }
      provider_campaigns: {
        Row: {
          brand: string | null
          created_at: string
          external_id: string
          id: string
          last_synced_at: string
          name: string | null
          org_id: string
          provider: string
          provider_status: string | null
          raw: Json | null
          status: string
          updated_at: string
          use_case: string | null
        }
        Insert: {
          brand?: string | null
          created_at?: string
          external_id: string
          id?: string
          last_synced_at?: string
          name?: string | null
          org_id: string
          provider: string
          provider_status?: string | null
          raw?: Json | null
          status?: string
          updated_at?: string
          use_case?: string | null
        }
        Update: {
          brand?: string | null
          created_at?: string
          external_id?: string
          id?: string
          last_synced_at?: string
          name?: string | null
          org_id?: string
          provider?: string
          provider_status?: string | null
          raw?: Json | null
          status?: string
          updated_at?: string
          use_case?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "provider_campaigns_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      provider_sender_numbers: {
        Row: {
          created_at: string
          id: string
          last_synced_at: string
          messaging_status: string | null
          org_id: string
          phone_e164: string
          provider: string
          provider_number_id: string | null
          raw: Json | null
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          last_synced_at?: string
          messaging_status?: string | null
          org_id: string
          phone_e164: string
          provider: string
          provider_number_id?: string | null
          raw?: Json | null
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          last_synced_at?: string
          messaging_status?: string | null
          org_id?: string
          phone_e164?: string
          provider?: string
          provider_number_id?: string | null
          raw?: Json | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "provider_sender_numbers_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      saved_filters: {
        Row: {
          created_at: string
          filters_json: Json
          id: string
          is_base: boolean
          last_count: number | null
          last_run_at: string | null
          name: string
          org_id: string
          starred: boolean
          updated_at: string
          user_id: string | null
        }
        Insert: {
          created_at?: string
          filters_json: Json
          id?: string
          is_base?: boolean
          last_count?: number | null
          last_run_at?: string | null
          name: string
          org_id: string
          starred?: boolean
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          created_at?: string
          filters_json?: Json
          id?: string
          is_base?: boolean
          last_count?: number | null
          last_run_at?: string | null
          name?: string
          org_id?: string
          starred?: boolean
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "saved_filters_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      sequence_enrollments: {
        Row: {
          completed_at: string | null
          contact_id: string | null
          current_step_index: number
          enrolled_at: string
          enrolled_by_user_id: string | null
          id: string
          next_run_at: string | null
          org_id: string
          pause_reason: string | null
          property_id: string
          sequence_id: string
          status: string
          updated_at: string
        }
        Insert: {
          completed_at?: string | null
          contact_id?: string | null
          current_step_index?: number
          enrolled_at?: string
          enrolled_by_user_id?: string | null
          id?: string
          next_run_at?: string | null
          org_id: string
          pause_reason?: string | null
          property_id: string
          sequence_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          completed_at?: string | null
          contact_id?: string | null
          current_step_index?: number
          enrolled_at?: string
          enrolled_by_user_id?: string | null
          id?: string
          next_run_at?: string | null
          org_id?: string
          pause_reason?: string | null
          property_id?: string
          sequence_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sequence_enrollments_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sequence_enrollments_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sequence_enrollments_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sequence_enrollments_sequence_id_fkey"
            columns: ["sequence_id"]
            isOneToOne: false
            referencedRelation: "sequences"
            referencedColumns: ["id"]
          },
        ]
      }
      sequence_step_runs: {
        Row: {
          created_at: string
          enrollment_id: string
          id: string
          message_id: string | null
          run_at: string | null
          scheduled_for: string
          skipped_reason: string | null
          step_id: string
        }
        Insert: {
          created_at?: string
          enrollment_id: string
          id?: string
          message_id?: string | null
          run_at?: string | null
          scheduled_for: string
          skipped_reason?: string | null
          step_id: string
        }
        Update: {
          created_at?: string
          enrollment_id?: string
          id?: string
          message_id?: string | null
          run_at?: string | null
          scheduled_for?: string
          skipped_reason?: string | null
          step_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sequence_step_runs_enrollment_id_fkey"
            columns: ["enrollment_id"]
            isOneToOne: false
            referencedRelation: "sequence_enrollments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sequence_step_runs_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sequence_step_runs_step_id_fkey"
            columns: ["step_id"]
            isOneToOne: false
            referencedRelation: "sequence_steps"
            referencedColumns: ["id"]
          },
        ]
      }
      sequence_steps: {
        Row: {
          action_type: string
          created_at: string
          delay_after_previous_minutes: number
          id: string
          sequence_id: string
          step_index: number
          target_status: string | null
          template_body: string | null
          template_category: string | null
          template_id: string | null
        }
        Insert: {
          action_type: string
          created_at?: string
          delay_after_previous_minutes?: number
          id?: string
          sequence_id: string
          step_index: number
          target_status?: string | null
          template_body?: string | null
          template_category?: string | null
          template_id?: string | null
        }
        Update: {
          action_type?: string
          created_at?: string
          delay_after_previous_minutes?: number
          id?: string
          sequence_id?: string
          step_index?: number
          target_status?: string | null
          template_body?: string | null
          template_category?: string | null
          template_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sequence_steps_sequence_id_fkey"
            columns: ["sequence_id"]
            isOneToOne: false
            referencedRelation: "sequences"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sequence_steps_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "sms_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      sequences: {
        Row: {
          active: boolean
          append_opt_out: boolean
          archived_at: string | null
          audience_type: string
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          name: string
          org_id: string
          trigger: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          append_opt_out?: boolean
          archived_at?: string | null
          audience_type?: string
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          name: string
          org_id: string
          trigger?: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          append_opt_out?: boolean
          archived_at?: string | null
          audience_type?: string
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          name?: string
          org_id?: string
          trigger?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sequences_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      skip_trace_cache: {
        Row: {
          address_normalized: string
          cost_credits: number
          created_at: string
          id: string
          match_count: number
          org_id: string
          provider: string
          result: Json
        }
        Insert: {
          address_normalized: string
          cost_credits?: number
          created_at?: string
          id?: string
          match_count?: number
          org_id: string
          provider: string
          result: Json
        }
        Update: {
          address_normalized?: string
          cost_credits?: number
          created_at?: string
          id?: string
          match_count?: number
          org_id?: string
          provider?: string
          result?: Json
        }
        Relationships: []
      }
      sms_templates: {
        Row: {
          category: string
          content: string
          created_at: string
          created_by: string | null
          deleted_at: string | null
          id: string
          name: string
          org_id: string
          system_managed: boolean
          updated_at: string
        }
        Insert: {
          category?: string
          content: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          id?: string
          name: string
          org_id: string
          system_managed?: boolean
          updated_at?: string
        }
        Update: {
          category?: string
          content?: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          id?: string
          name?: string
          org_id?: string
          system_managed?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sms_templates_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      tags: {
        Row: {
          auto_apply_rule: Json | null
          category: string
          color: string | null
          created_at: string
          id: string
          name: string
          org_id: string
          system_managed: boolean
        }
        Insert: {
          auto_apply_rule?: Json | null
          category?: string
          color?: string | null
          created_at?: string
          id?: string
          name: string
          org_id?: string
          system_managed?: boolean
        }
        Update: {
          auto_apply_rule?: Json | null
          category?: string
          color?: string | null
          created_at?: string
          id?: string
          name?: string
          org_id?: string
          system_managed?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "tags_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      sms_inbound_deliveries: {
        Row: {
          classification: string
          created_at: string
          id: string
          intent_id: string | null
          org_id: string
          payload_sha256: string
          provider: string
          provider_message_id: string
          received_at: string
          webhook_event_id: string | null
        }
        Insert: {
          classification: string
          created_at?: string
          id?: string
          intent_id?: string | null
          org_id: string
          payload_sha256: string
          provider: string
          provider_message_id: string
          received_at: string
          webhook_event_id?: string | null
        }
        Update: {
          classification?: string
          created_at?: string
          id?: string
          intent_id?: string | null
          org_id?: string
          payload_sha256?: string
          provider?: string
          provider_message_id?: string
          received_at?: string
          webhook_event_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sms_inbound_deliveries_intent_id_fkey"
            columns: ["intent_id"]
            isOneToOne: false
            referencedRelation: "sms_inbound_intents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sms_inbound_deliveries_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sms_inbound_deliveries_webhook_event_id_fkey"
            columns: ["webhook_event_id"]
            isOneToOne: false
            referencedRelation: "webhook_events"
            referencedColumns: ["id"]
          },
        ]
      }
      sms_inbound_intents: {
        Row: {
          body_fingerprint: string
          canonical_message_id: string | null
          contact_id: string | null
          conversation_id: string | null
          created_at: string
          dedupe_range: string
          dedupe_scope_hash: string
          duplicate_count: number
          fingerprint_version: number
          first_provider_message_id: string
          from_address: string
          id: string
          last_provider_message_id: string
          org_id: string
          property_id: string | null
          provider: string
          received_at: string
          routing_resolution: string | null
          status: string
          to_address: string
          updated_at: string
        }
        Insert: {
          body_fingerprint: string
          canonical_message_id?: string | null
          contact_id?: string | null
          conversation_id?: string | null
          created_at?: string
          dedupe_range: string
          dedupe_scope_hash: string
          duplicate_count?: number
          fingerprint_version?: number
          first_provider_message_id: string
          from_address: string
          id?: string
          last_provider_message_id: string
          org_id: string
          property_id?: string | null
          provider: string
          received_at: string
          routing_resolution?: string | null
          status?: string
          to_address: string
          updated_at?: string
        }
        Update: {
          body_fingerprint?: string
          canonical_message_id?: string | null
          contact_id?: string | null
          conversation_id?: string | null
          created_at?: string
          dedupe_range?: string
          dedupe_scope_hash?: string
          duplicate_count?: number
          fingerprint_version?: number
          first_provider_message_id?: string
          from_address?: string
          id?: string
          last_provider_message_id?: string
          org_id?: string
          property_id?: string | null
          provider?: string
          received_at?: string
          routing_resolution?: string | null
          status?: string
          to_address?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sms_inbound_intents_canonical_message_fkey"
            columns: ["canonical_message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sms_inbound_intents_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sms_inbound_intents_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sms_inbound_intents_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      task_calendar_mutations: {
        Row: {
          attempts: number
          calendar_chain_id: string
          client_event_id: string | null
          created_at: string
          event_id: string | null
          expected_generation: number
          id: string
          last_error: string | null
          new_assignee_id: string | null
          new_event_id: string | null
          old_assignee_id: string
          operation: string
          org_id: string
          phase: string
          result_reason: string | null
          source_task_id: string
          target_task_id: string | null
          updated_at: string
        }
        Insert: {
          attempts?: number
          calendar_chain_id: string
          client_event_id?: string | null
          created_at?: string
          event_id?: string | null
          expected_generation: number
          id?: string
          last_error?: string | null
          new_assignee_id?: string | null
          new_event_id?: string | null
          old_assignee_id: string
          operation: string
          org_id: string
          phase?: string
          result_reason?: string | null
          source_task_id: string
          target_task_id?: string | null
          updated_at?: string
        }
        Update: {
          attempts?: number
          calendar_chain_id?: string
          client_event_id?: string | null
          created_at?: string
          event_id?: string | null
          expected_generation?: number
          id?: string
          last_error?: string | null
          new_assignee_id?: string | null
          new_event_id?: string | null
          old_assignee_id?: string
          operation?: string
          org_id?: string
          phase?: string
          result_reason?: string | null
          source_task_id?: string
          target_task_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_calendar_mutations_source_task_fkey"
            columns: ["source_task_id", "org_id", "calendar_chain_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id", "org_id", "calendar_chain_id"]
          },
          {
            foreignKeyName: "task_calendar_mutations_target_task_fkey"
            columns: ["target_task_id", "org_id", "calendar_chain_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id", "org_id", "calendar_chain_id"]
          },
        ]
      }
      task_reminder_deliveries: {
        Row: {
          attempts: number
          channel: string
          created_at: string
          id: string
          last_error: string | null
          org_id: string
          provider_message_id: string | null
          sent_at: string | null
          status: string
          task_id: string
        }
        Insert: {
          attempts?: number
          channel: string
          created_at?: string
          id?: string
          last_error?: string | null
          org_id: string
          provider_message_id?: string | null
          sent_at?: string | null
          status?: string
          task_id: string
        }
        Update: {
          attempts?: number
          channel?: string
          created_at?: string
          id?: string
          last_error?: string | null
          org_id?: string
          provider_message_id?: string | null
          sent_at?: string | null
          status?: string
          task_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_reminder_deliveries_task_org_fkey"
            columns: ["task_id", "org_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id", "org_id"]
          },
        ]
      }
      tasks: {
        Row: {
          assignee_id: string
          calendar_chain_id: string | null
          calendar_generation: number
          completed_at: string | null
          completed_by: string | null
          contact_id: string | null
          created_at: string
          created_by: string
          description: string | null
          due_at: string
          end_at: string | null
          google_calendar_event_id: string | null
          id: string
          lead_next_action_idempotency_key: string | null
          org_id: string
          outcome: string | null
          related_property_id: string | null
          reminder_claimed_at: string | null
          slack_channel_id: string | null
          slack_message_ts: string | null
          snoozed_until: string | null
          status: string
          title: string
          type: string
          updated_at: string
        }
        Insert: {
          assignee_id: string
          calendar_chain_id?: string | null
          calendar_generation?: number
          completed_at?: string | null
          completed_by?: string | null
          contact_id?: string | null
          created_at?: string
          created_by: string
          description?: string | null
          due_at: string
          end_at?: string | null
          google_calendar_event_id?: string | null
          id?: string
          lead_next_action_idempotency_key?: string | null
          org_id: string
          outcome?: string | null
          related_property_id?: string | null
          reminder_claimed_at?: string | null
          slack_channel_id?: string | null
          slack_message_ts?: string | null
          snoozed_until?: string | null
          status?: string
          title: string
          type: string
          updated_at?: string
        }
        Update: {
          assignee_id?: string
          calendar_chain_id?: string | null
          calendar_generation?: number
          completed_at?: string | null
          completed_by?: string | null
          contact_id?: string | null
          created_at?: string
          created_by?: string
          description?: string | null
          due_at?: string
          end_at?: string | null
          google_calendar_event_id?: string | null
          id?: string
          lead_next_action_idempotency_key?: string | null
          org_id?: string
          outcome?: string | null
          related_property_id?: string | null
          reminder_claimed_at?: string | null
          slack_channel_id?: string | null
          slack_message_ts?: string | null
          snoozed_until?: string | null
          status?: string
          title?: string
          type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tasks_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_related_property_org_fkey"
            columns: ["related_property_id", "org_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "tasks_contact_org_fkey"
            columns: ["contact_id", "org_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id", "org_id"]
          },
        ]
      }
      test_sms_log: {
        Row: {
          body: string
          external_id: string | null
          from_number: string
          id: string
          provider: string
          raw_payload: Json
          received_at: string
          signature_verified: boolean
          to_number: string
        }
        Insert: {
          body: string
          external_id?: string | null
          from_number: string
          id?: string
          provider?: string
          raw_payload: Json
          received_at?: string
          signature_verified?: boolean
          to_number: string
        }
        Update: {
          body?: string
          external_id?: string | null
          from_number?: string
          id?: string
          provider?: string
          raw_payload?: Json
          received_at?: string
          signature_verified?: boolean
          to_number?: string
        }
        Relationships: []
      }
      user_integration_prefs: {
        Row: {
          channel: string
          created_at: string
          enabled: boolean
          reminder_phone: string | null
          timezone: string
          updated_at: string
          user_id: string
        }
        Insert: {
          channel: string
          created_at?: string
          enabled?: boolean
          reminder_phone?: string | null
          timezone?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          channel?: string
          created_at?: string
          enabled?: boolean
          reminder_phone?: string | null
          timezone?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      esign_requests: {
        Row: {
          completed_at: string | null
          created_at: string
          created_by: string
          delivery_state: Database["public"]["Enums"]["esign_delivery_state"]
          details_url: string | null
          error_message: string | null
          id: string
          merge_value_snapshot: Json
          org_id: string
          payload_hash: string
          property_id: string
          provider_event_at: string | null
          retry_of_request_id: string | null
          send_intent_id: string
          sent_at: string | null
          sign_request_id: string | null
          signed_pdf_path: string | null
          signer_snapshot: Json
          status: Database["public"]["Enums"]["esign_request_status"]
          template_id: string
          test_mode: boolean
          updated_at: string
          updated_by: string | null
          void_claim_token: string | null
          void_claimed_at: string | null
          void_requested_at: string | null
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          created_by: string
          delivery_state?: Database["public"]["Enums"]["esign_delivery_state"]
          details_url?: string | null
          error_message?: string | null
          id?: string
          merge_value_snapshot?: Json
          org_id: string
          payload_hash: string
          property_id: string
          provider_event_at?: string | null
          retry_of_request_id?: string | null
          send_intent_id: string
          sent_at?: string | null
          sign_request_id?: string | null
          signed_pdf_path?: string | null
          signer_snapshot: Json
          status?: Database["public"]["Enums"]["esign_request_status"]
          template_id: string
          test_mode?: boolean
          updated_at?: string
          updated_by?: string | null
          void_claim_token?: string | null
          void_claimed_at?: string | null
          void_requested_at?: string | null
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          created_by?: string
          delivery_state?: Database["public"]["Enums"]["esign_delivery_state"]
          details_url?: string | null
          error_message?: string | null
          id?: string
          merge_value_snapshot?: Json
          org_id?: string
          payload_hash?: string
          property_id?: string
          provider_event_at?: string | null
          retry_of_request_id?: string | null
          send_intent_id?: string
          sent_at?: string | null
          sign_request_id?: string | null
          signed_pdf_path?: string | null
          signer_snapshot?: Json
          status?: Database["public"]["Enums"]["esign_request_status"]
          template_id?: string
          test_mode?: boolean
          updated_at?: string
          updated_by?: string | null
          void_claim_token?: string | null
          void_claimed_at?: string | null
          void_requested_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "esign_requests_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "esign_requests_property_org_fkey"
            columns: ["property_id", "org_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "esign_requests_retry_org_fkey"
            columns: ["retry_of_request_id", "org_id"]
            isOneToOne: false
            referencedRelation: "esign_requests"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "esign_requests_template_org_fkey"
            columns: ["template_id", "org_id"]
            isOneToOne: false
            referencedRelation: "esign_templates"
            referencedColumns: ["id", "org_id"]
          },
        ]
      }
      esign_request_signers: {
        Row: {
          created_at: string
          declined_at: string | null
          id: string
          last_reminded_at: string | null
          org_id: string
          provider_signature_id: string | null
          reminder_claim_token: string | null
          reminder_claimed_at: string | null
          request_id: string
          role_name: string
          signed_at: string | null
          signer_email: string
          signer_name: string
          signer_order: number
          status: string
          updated_at: string
          viewed_at: string | null
        }
        Insert: {
          created_at?: string
          declined_at?: string | null
          id?: string
          last_reminded_at?: string | null
          org_id: string
          provider_signature_id?: string | null
          reminder_claim_token?: string | null
          reminder_claimed_at?: string | null
          request_id: string
          role_name: string
          signed_at?: string | null
          signer_email: string
          signer_name: string
          signer_order: number
          status?: string
          updated_at?: string
          viewed_at?: string | null
        }
        Update: {
          created_at?: string
          declined_at?: string | null
          id?: string
          last_reminded_at?: string | null
          org_id?: string
          provider_signature_id?: string | null
          reminder_claim_token?: string | null
          reminder_claimed_at?: string | null
          request_id?: string
          role_name?: string
          signed_at?: string | null
          signer_email?: string
          signer_name?: string
          signer_order?: number
          status?: string
          updated_at?: string
          viewed_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "esign_request_signers_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "esign_request_signers_request_org_fkey"
            columns: ["request_id", "org_id"]
            isOneToOne: false
            referencedRelation: "esign_requests"
            referencedColumns: ["id", "org_id"]
          },
        ]
      }
      esign_template_staging_sources: {
        Row: {
          cleanup_attempted_at: string | null
          cleanup_error_code: string | null
          cleanup_outcome: string
          content_type: string
          created_at: string
          created_by: string
          id: string
          org_id: string
          source_filename: string
          source_sha256: string
          source_size_bytes: number
          storage_bucket: string
          storage_path: string
          verified_at: string
        }
        Insert: {
          cleanup_attempted_at?: string | null
          cleanup_error_code?: string | null
          cleanup_outcome?: string
          content_type: string
          created_at?: string
          created_by: string
          id: string
          org_id: string
          source_filename: string
          source_sha256: string
          source_size_bytes: number
          storage_bucket?: string
          storage_path: string
          verified_at?: string
        }
        Update: {
          cleanup_attempted_at?: string | null
          cleanup_error_code?: string | null
          cleanup_outcome?: string
          content_type?: string
          created_at?: string
          created_by?: string
          id?: string
          org_id?: string
          source_filename?: string
          source_sha256?: string
          source_size_bytes?: number
          storage_bucket?: string
          storage_path?: string
          verified_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "esign_template_staging_sources_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      esign_templates: {
        Row: {
          abandoned_at: string | null
          abandoned_by: string | null
          created_at: string
          created_by: string
          deleted_at: string | null
          deleted_by: string | null
          document_type: string
          duplicate_of_template_id: string | null
          finalized_at: string | null
          id: string
          lifecycle_state: string
          merge_field_names: string[]
          name: string
          org_id: string
          preparation_error_code: string | null
          seller_role: string
          sign_template_id: string | null
          signer_roles: Json
          source_content_type: string | null
          source_filename: string | null
          source_sha256: string | null
          source_size_bytes: number | null
          staging_deleted_at: string | null
          staging_path: string | null
          staging_source_id: string | null
          supersedes_template_id: string | null
          updated_at: string
          updated_by: string
        }
        Insert: {
          abandoned_at?: string | null
          abandoned_by?: string | null
          created_at?: string
          created_by: string
          deleted_at?: string | null
          deleted_by?: string | null
          document_type: string
          duplicate_of_template_id?: string | null
          finalized_at?: string | null
          id?: string
          lifecycle_state?: string
          merge_field_names: string[]
          name: string
          org_id: string
          preparation_error_code?: string | null
          seller_role: string
          sign_template_id?: string | null
          signer_roles: Json
          source_content_type?: string | null
          source_filename?: string | null
          source_sha256?: string | null
          source_size_bytes?: number | null
          staging_deleted_at?: string | null
          staging_path?: string | null
          staging_source_id?: string | null
          supersedes_template_id?: string | null
          updated_at?: string
          updated_by: string
        }
        Update: {
          abandoned_at?: string | null
          abandoned_by?: string | null
          created_at?: string
          created_by?: string
          deleted_at?: string | null
          deleted_by?: string | null
          document_type?: string
          duplicate_of_template_id?: string | null
          finalized_at?: string | null
          id?: string
          lifecycle_state?: string
          merge_field_names?: string[]
          name?: string
          org_id?: string
          preparation_error_code?: string | null
          seller_role?: string
          sign_template_id?: string | null
          signer_roles?: Json
          source_content_type?: string | null
          source_filename?: string | null
          source_sha256?: string | null
          source_size_bytes?: number | null
          staging_deleted_at?: string | null
          staging_path?: string | null
          staging_source_id?: string | null
          supersedes_template_id?: string | null
          updated_at?: string
          updated_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "esign_templates_duplicate_org_fkey"
            columns: ["duplicate_of_template_id", "org_id"]
            isOneToOne: false
            referencedRelation: "esign_templates"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "esign_templates_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "esign_templates_staging_source_org_fkey"
            columns: ["staging_source_id", "org_id"]
            isOneToOne: false
            referencedRelation: "esign_template_staging_sources"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "esign_templates_supersedes_org_fkey"
            columns: ["supersedes_template_id", "org_id"]
            isOneToOne: false
            referencedRelation: "esign_templates"
            referencedColumns: ["id", "org_id"]
          },
        ]
      }
      esign_webhook_receipts: {
        Row: {
          attempt_count: number
          callback_consumer_id: string
          esign_request_id: string | null
          event_fingerprint: string
          event_hash: string
          event_type: string
          id: string
          org_id: string
          payload_hash: string
          processed_at: string | null
          processing_error: string | null
          processing_lease_id: string | null
          processing_started_at: string | null
          processing_status: string
          provider_event_at: string | null
          received_at: string
          related_signature_id: string | null
          safe_event_data: Json
          sign_request_id: string | null
        }
        Insert: {
          attempt_count?: number
          callback_consumer_id: string
          esign_request_id?: string | null
          event_fingerprint: string
          event_hash: string
          event_type: string
          id?: string
          org_id: string
          payload_hash: string
          processed_at?: string | null
          processing_error?: string | null
          processing_lease_id?: string | null
          processing_started_at?: string | null
          processing_status?: string
          provider_event_at?: string | null
          received_at?: string
          related_signature_id?: string | null
          safe_event_data: Json
          sign_request_id?: string | null
        }
        Update: {
          attempt_count?: number
          callback_consumer_id?: string
          esign_request_id?: string | null
          event_fingerprint?: string
          event_hash?: string
          event_type?: string
          id?: string
          org_id?: string
          payload_hash?: string
          processed_at?: string | null
          processing_error?: string | null
          processing_lease_id?: string | null
          processing_started_at?: string | null
          processing_status?: string
          provider_event_at?: string | null
          received_at?: string
          related_signature_id?: string | null
          safe_event_data?: Json
          sign_request_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "esign_webhook_receipts_callback_consumer_org_fkey"
            columns: ["callback_consumer_id", "org_id"]
            isOneToOne: false
            referencedRelation: "webhook_consumers"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "esign_webhook_receipts_request_org_fkey"
            columns: ["esign_request_id", "org_id"]
            isOneToOne: false
            referencedRelation: "esign_requests"
            referencedColumns: ["id", "org_id"]
          },
        ]
      }
      lead_files: {
        Row: {
          content_type: string
          created_at: string
          created_by: string | null
          file_name: string
          id: string
          org_id: string
          property_id: string
          size_bytes: number
          source: string
          source_request_id: string
          storage_bucket: string
          storage_path: string
        }
        Insert: {
          content_type?: string
          created_at?: string
          created_by?: string | null
          file_name: string
          id?: string
          org_id: string
          property_id: string
          size_bytes: number
          source?: string
          source_request_id: string
          storage_bucket?: string
          storage_path: string
        }
        Update: {
          content_type?: string
          created_at?: string
          created_by?: string | null
          file_name?: string
          id?: string
          org_id?: string
          property_id?: string
          size_bytes?: number
          source?: string
          source_request_id?: string
          storage_bucket?: string
          storage_path?: string
        }
        Relationships: [
          {
            foreignKeyName: "lead_files_property_org_fkey"
            columns: ["property_id", "org_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "lead_files_request_org_fkey"
            columns: ["source_request_id", "org_id"]
            isOneToOne: false
            referencedRelation: "esign_requests"
            referencedColumns: ["id", "org_id"]
          },
        ]
      }
      org_esign_integrations: {
        Row: {
          api_key_encrypted: string
          api_key_last_four: string
          callback_consumer_id: string
          callback_verified_at: string | null
          client_id: string
          connected_by: string
          created_at: string
          id: string
          org_id: string
          provider: string
          sending_enabled: boolean
          test_mode: boolean
          updated_at: string
          updated_by: string
        }
        Insert: {
          api_key_encrypted: string
          api_key_last_four: string
          callback_consumer_id: string
          callback_verified_at?: string | null
          client_id: string
          connected_by: string
          created_at?: string
          id?: string
          org_id: string
          provider?: string
          sending_enabled?: boolean
          test_mode?: boolean
          updated_at?: string
          updated_by: string
        }
        Update: {
          api_key_encrypted?: string
          api_key_last_four?: string
          callback_consumer_id?: string
          callback_verified_at?: string | null
          client_id?: string
          connected_by?: string
          created_at?: string
          id?: string
          org_id?: string
          provider?: string
          sending_enabled?: boolean
          test_mode?: boolean
          updated_at?: string
          updated_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "org_esign_integrations_callback_consumer_org_fkey"
            columns: ["callback_consumer_id", "org_id"]
            isOneToOne: true
            referencedRelation: "webhook_consumers"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "org_esign_integrations_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      user_oauth_tokens: {
        Row: {
          access_token_encrypted: string
          access_token_expires_at: string | null
          created_at: string
          external_account_id: string | null
          provider: string
          refresh_token_encrypted: string | null
          scopes: string[]
          token_type: string
          updated_at: string
          user_id: string
        }
        Insert: {
          access_token_encrypted: string
          access_token_expires_at?: string | null
          created_at?: string
          external_account_id?: string | null
          provider: string
          refresh_token_encrypted?: string | null
          scopes?: string[]
          token_type: string
          updated_at?: string
          user_id: string
        }
        Update: {
          access_token_encrypted?: string
          access_token_expires_at?: string | null
          created_at?: string
          external_account_id?: string | null
          provider?: string
          refresh_token_encrypted?: string | null
          scopes?: string[]
          token_type?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      webhook_consumers: {
        Row: {
          consumer_type: string
          created_at: string
          created_by: string | null
          default_source: string | null
          enabled: boolean
          id: string
          last_used_at: string | null
          name: string
          notes: string | null
          org_id: string
          revoked_at: string | null
          secret_hash: string
        }
        Insert: {
          consumer_type: string
          created_at?: string
          created_by?: string | null
          default_source?: string | null
          enabled?: boolean
          id?: string
          last_used_at?: string | null
          name: string
          notes?: string | null
          org_id?: string
          revoked_at?: string | null
          secret_hash: string
        }
        Update: {
          consumer_type?: string
          created_at?: string
          created_by?: string | null
          default_source?: string | null
          enabled?: boolean
          id?: string
          last_used_at?: string | null
          name?: string
          notes?: string | null
          org_id?: string
          revoked_at?: string | null
          secret_hash?: string
        }
        Relationships: [
          {
            foreignKeyName: "webhook_consumers_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      webhook_events: {
        Row: {
          error_message: string | null
          event_type: string
          external_id: string
          id: string
          org_id: string
          payload: Json
          processed_at: string | null
          processing_started_at: string | null
          processing_status: string
          provider: string
          request_hash: string | null
          received_at: string
          signature_verified: boolean
        }
        Insert: {
          error_message?: string | null
          event_type: string
          external_id: string
          id?: string
          org_id?: string
          payload: Json
          processed_at?: string | null
          processing_started_at?: string | null
          processing_status?: string
          provider: string
          request_hash?: string | null
          received_at?: string
          signature_verified?: boolean
        }
        Update: {
          error_message?: string | null
          event_type?: string
          external_id?: string
          id?: string
          org_id?: string
          payload?: Json
          processed_at?: string | null
          processing_started_at?: string | null
          processing_status?: string
          provider?: string
          request_hash?: string | null
          received_at?: string
          signature_verified?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "webhook_events_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      zip_county_xref: {
        Row: {
          fips_code: string
          is_primary: boolean
          zip: string
        }
        Insert: {
          fips_code: string
          is_primary?: boolean
          zip: string
        }
        Update: {
          fips_code?: string
          is_primary?: boolean
          zip?: string
        }
        Relationships: [
          {
            foreignKeyName: "zip_county_xref_fips_code_fkey"
            columns: ["fips_code"]
            isOneToOne: false
            referencedRelation: "fips_codes"
            referencedColumns: ["fips_code"]
          },
        ]
      }
      message_threads: {
        Row: {
          ai_last_delivery_error: string | null
          ai_last_delivery_status: string | null
          ai_responder_message_id: string | null
          ai_responder_reason: string | null
          ai_responder_status: string | null
          ai_responder_status_at: string | null
          channel: string
          contact_id: string
          conversation_id: string
          created_at: string
          id: string
          org_id: string
          property_id: string
          updated_at: string
        }
        Insert: {
          ai_last_delivery_error?: string | null
          ai_last_delivery_status?: string | null
          ai_responder_message_id?: string | null
          ai_responder_reason?: string | null
          ai_responder_status?: string | null
          ai_responder_status_at?: string | null
          channel: string
          contact_id: string
          conversation_id?: string
          created_at?: string
          id?: string
          org_id?: string
          property_id: string
          updated_at?: string
        }
        Update: {
          ai_last_delivery_error?: string | null
          ai_last_delivery_status?: string | null
          ai_responder_message_id?: string | null
          ai_responder_reason?: string | null
          ai_responder_status?: string | null
          ai_responder_status_at?: string | null
          channel?: string
          contact_id?: string
          conversation_id?: string
          created_at?: string
          id?: string
          org_id?: string
          property_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "message_threads_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "message_threads_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "message_threads_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      available_esign_templates: {
        Row: {
          abandoned_at: string | null
          abandoned_by: string | null
          created_at: string | null
          created_by: string | null
          deleted_at: string | null
          deleted_by: string | null
          document_type: string | null
          duplicate_of_template_id: string | null
          finalized_at: string | null
          id: string | null
          lifecycle_state: string | null
          merge_field_names: string[] | null
          name: string | null
          org_id: string | null
          preparation_error_code: string | null
          seller_role: string | null
          sign_template_id: string | null
          signer_roles: Json | null
          source_content_type: string | null
          source_filename: string | null
          source_sha256: string | null
          source_size_bytes: number | null
          staging_deleted_at: string | null
          staging_path: string | null
          staging_source_id: string | null
          supersedes_template_id: string | null
          updated_at: string | null
          updated_by: string | null
        }
        Insert: {
          abandoned_at?: string | null
          abandoned_by?: string | null
          created_at?: string | null
          created_by?: string | null
          deleted_at?: string | null
          deleted_by?: string | null
          document_type?: string | null
          duplicate_of_template_id?: string | null
          finalized_at?: string | null
          id?: string | null
          lifecycle_state?: string | null
          merge_field_names?: string[] | null
          name?: string | null
          org_id?: string | null
          preparation_error_code?: string | null
          seller_role?: string | null
          sign_template_id?: string | null
          signer_roles?: Json | null
          source_content_type?: string | null
          source_filename?: string | null
          source_sha256?: string | null
          source_size_bytes?: number | null
          staging_deleted_at?: string | null
          staging_path?: string | null
          staging_source_id?: string | null
          supersedes_template_id?: string | null
          updated_at?: string | null
          updated_by?: string | null
        }
        Update: {
          abandoned_at?: string | null
          abandoned_by?: string | null
          created_at?: string | null
          created_by?: string | null
          deleted_at?: string | null
          deleted_by?: string | null
          document_type?: string | null
          duplicate_of_template_id?: string | null
          finalized_at?: string | null
          id?: string | null
          lifecycle_state?: string | null
          merge_field_names?: string[] | null
          name?: string | null
          org_id?: string | null
          preparation_error_code?: string | null
          seller_role?: string | null
          sign_template_id?: string | null
          signer_roles?: Json | null
          source_content_type?: string | null
          source_filename?: string | null
          source_sha256?: string | null
          source_size_bytes?: number | null
          staging_deleted_at?: string | null
          staging_path?: string | null
          staging_source_id?: string | null
          supersedes_template_id?: string | null
          updated_at?: string | null
          updated_by?: string | null
        }
        Relationships: []
      }
      leads_board: {
        Row: {
          absentee_flag: boolean | null
          address: string
          assigned_user_id: string | null
          cass_status: string | null
          city: string
          created_at: string
          deleted_at: string | null
          has_unread: boolean
          homeowner: Json | null
          homeowner_sms_opted_out: boolean | null
          homeowner_sms_opted_out_at: string | null
          id: string
          has_active_sequence: boolean
          is_dnc_locked: boolean
          is_skip_traced: boolean
          is_stale: boolean
          is_vacant: boolean | null
          last_message_body: string | null
          last_message_created_at: string | null
          last_message_direction: string | null
          market: string | null
          motivation_level: string | null
          next_task_due_at: string | null
          next_task_id: string | null
          next_task_title: string | null
          outreach_dispo: string | null
          search_text: string
          sequence_ended_without_follow_up: boolean
          state: string
          status: string
          zip: string | null
        }
        Relationships: []
      }
      leads_unskip_traced: {
        Row: {
          absentee_flag: boolean | null
          address: string
          assigned_user_id: string | null
          cass_status: string | null
          city: string
          created_at: string
          deleted_at: string | null
          has_unread: boolean
          homeowner: Json | null
          id: string
          has_active_sequence: boolean
          is_dnc_locked: boolean
          is_skip_traced: boolean
          is_stale: boolean
          is_vacant: boolean | null
          last_message_body: string | null
          last_message_created_at: string | null
          last_message_direction: string | null
          market: string | null
          motivation_level: string | null
          next_task_due_at: string | null
          next_task_id: string | null
          next_task_title: string | null
          outreach_dispo: string | null
          search_text: string
          sequence_ended_without_follow_up: boolean
          state: string
          status: string
          zip: string | null
        }
        Relationships: []
      }
      property_stack_counts: {
        Row: {
          list_ids: string[] | null
          property_id: string | null
          stack_count: number | null
        }
        Relationships: [
          {
            foreignKeyName: "property_lists_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      abandon_esign_template_draft: {
        Args: { p_actor_id: string; p_org_id: string; p_template_id: string }
        Returns: string
      }
      apply_esign_webhook_status_decision: {
        Args: {
          p_expected_status: Database["public"]["Enums"]["esign_request_status"]
          p_lead_event_payload: Json | null
          p_lead_event_type: string | null
          p_lease_id: string
          p_org_id: string
          p_provider_event_at: string
          p_receipt_id: string
          p_request_id: string
          p_requested_status: Database["public"]["Enums"]["esign_request_status"]
        }
        Returns: {
          outcome: string
          status: Database["public"]["Enums"]["esign_request_status"]
        }[]
      }
      attach_esign_template_provider_id: {
        Args: {
          p_actor_id: string
          p_org_id: string
          p_provider_template_id: string
          p_template_id: string
        }
        Returns: string
      }
      claim_esign_request_void: {
        Args: {
          p_claim_token: string
          p_org_id: string
          p_request_id: string
        }
        Returns: {
          outcome: string
          provider_request_id: string | null
        }[]
      }
      claim_esign_signer_reminder: {
        Args: {
          p_claim_token: string
          p_org_id: string
          p_request_id: string
          p_signer_id: string
        }
        Returns: {
          outcome: string
          provider_request_id: string | null
          provider_signature_id: string | null
          signer_email: string | null
          signer_name: string | null
        }[]
      }
      claim_esign_webhook_receipt: {
        Args: {
          p_callback_consumer_id: string
          p_event_fingerprint: string
          p_event_hash: string
          p_event_type: string
          p_lease_id: string
          p_org_id: string
          p_payload_hash: string
          p_provider_event_at: string | null
          p_received_at: string
          p_related_signature_id: string | null
          p_safe_event_data: Json
          p_sign_request_id: string | null
          p_stale_after_seconds: number
        }
        Returns: {
          lease_id: string | null
          outcome: string
          receipt_id: string
        }[]
      }
      claim_verified_esign_webhook_receipt: {
        Args: {
          p_callback_consumer_id: string
          p_event_fingerprint: string
          p_event_hash: string
          p_event_type: string
          p_lease_id: string
          p_org_id: string
          p_payload_hash: string
          p_provider_event_at: string | null
          p_received_at: string
          p_related_signature_id: string | null
          p_safe_event_data: Json
          p_sign_request_id: string | null
          p_stale_after?: string
        }
        Returns: {
          lease_id: string | null
          outcome: string
          receipt_id: string
        }[]
      }
      complete_esign_webhook_receipt: {
        Args: {
          p_lease_id: string
          p_receipt_id: string
          p_safe_code?: string | null
          p_status: string
        }
        Returns: undefined
      }
      create_esign_request: {
        Args: {
          p_actor_id: string
          p_merge_value_snapshot: Json
          p_org_id: string
          p_payload_hash: string
          p_property_id: string
          p_retry_of_request_id: string | null
          p_send_intent_id: string
          p_signer_snapshot: Json
          p_template_id: string
        }
        Returns: {
          blocker_code: string | null
          created_at: string | null
          delivery_state:
            Database["public"]["Enums"]["esign_delivery_state"] | null
          id: string | null
          merge_value_snapshot: Json
          org_id: string
          outcome: Database["public"]["Enums"]["esign_request_claim_outcome"]
          payload_hash: string
          property_id: string
          retry_of_request_id: string | null
          send_intent_id: string
          signer_snapshot: Json
          status: Database["public"]["Enums"]["esign_request_status"] | null
          template_id: string
          test_mode: boolean
        }[]
      }
      create_esign_template_draft: {
        Args: {
          p_actor_id: string
          p_document_type: string
          p_name: string
          p_org_id: string
          p_seller_role: string
          p_signer_roles: Json
          p_source_id: string
        }
        Returns: string
      }
      create_esign_template_duplicate_draft: {
        Args: {
          p_actor_id: string
          p_name: string
          p_org_id: string
          p_source_template_id: string
        }
        Returns: string
      }
      create_esign_template_edit_revision: {
        Args: {
          p_actor_id: string
          p_org_id: string
          p_source_id: string
          p_source_template_id: string
        }
        Returns: string
      }
      delete_org_esign_integration: {
        Args: { p_actor_id: string; p_org_id: string }
        Returns: undefined
      }
      esign_is_active_org_owner: {
        Args: { p_org_id: string }
        Returns: boolean
      }
      esign_merge_fields_are_valid: {
        Args: { p_fields: string[] }
        Returns: boolean
      }
      esign_request_payload_is_valid: {
        Args: {
          p_merge_values: Json
          p_signers: Json
          p_template_roles: Json
        }
        Returns: boolean
      }
      esign_require_active_owner: {
        Args: { p_actor_id: string; p_org_id: string }
        Returns: undefined
      }
      esign_safe_event_data_is_valid: {
        Args: { p_data: Json }
        Returns: boolean
      }
      esign_signer_roles_are_valid: {
        Args: { p_roles: Json; p_seller_role: string }
        Returns: boolean
      }
      esign_staging_path_is_valid: {
        Args: { p_path: string }
        Returns: boolean
      }
      esign_storage_org_id: {
        Args: { p_path: string }
        Returns: string
      }
      finalize_esign_request_void: {
        Args: { p_claim_token: string; p_org_id: string; p_request_id: string }
        Returns: string
      }
      finalize_esign_signer_reminder: {
        Args: {
          p_claim_token: string
          p_org_id: string
          p_request_id: string
          p_signer_id: string
        }
        Returns: string
      }
      finalize_esign_template: {
        Args: {
          p_actor_id: string
          p_org_id: string
          p_provider_merge_field_names: string[]
          p_provider_signer_roles: Json
          p_provider_template_id: string
          p_seller_role: string
          p_template_id: string
        }
        Returns: string
      }
      publish_esign_template_edit_revision: {
        Args: {
          p_actor_id: string
          p_expected_source_provider_template_id: string
          p_org_id: string
          p_provider_merge_field_names: string[]
          p_provider_signer_roles: Json
          p_revision_provider_template_id: string
          p_revision_template_id: string
          p_seller_role: string
          p_source_template_id: string
        }
        Returns: string
      }
      find_esign_webhook_request: {
        Args: { p_org_id: string; p_sign_request_id: string }
        Returns: {
          id: string
          org_id: string
          property_id: string
          signed_pdf_path: string | null
          status: Database["public"]["Enums"]["esign_request_status"]
          template_title: string
        }[]
      }
      get_org_esign_credentials: {
        Args: { p_key: string; p_org_id: string }
        Returns: {
          api_key: string
          callback_secret_hash: string
          client_id: string
          sending_enabled: boolean
          test_mode: boolean
        }[]
      }
      get_latest_esign_requests_for_properties: {
        Args: { p_org_id: string; p_property_ids: string[] }
        Returns: {
          created_at: string
          id: string
          org_id: string
          property_id: string
          status: Database["public"]["Enums"]["esign_request_status"]
        }[]
      }
      link_esign_signed_artifact: {
        Args: {
          p_content_type: string
          p_lead_event_payload: Json
          p_lead_event_type: string
          p_lead_file_id: string
          p_lease_id: string
          p_org_id: string
          p_receipt_id: string
          p_request_id: string
          p_size_bytes: number
          p_storage_bucket: string
          p_storage_path: string
        }
        Returns: {
          lead_file_id: string
          outcome: string
        }[]
      }
      mark_esign_request_send_outcome: {
        Args: {
          p_delivery_state: Database["public"]["Enums"]["esign_delivery_state"]
          p_error_message: string | null
          p_org_id: string
          p_request_id: string
        }
        Returns: undefined
      }
      reconcile_esign_request_delivery: {
        Args: {
          p_details_url: string | null
          p_org_id: string
          p_provider_request_id: string
          p_provider_signatures: Json
          p_request_id: string
        }
        Returns: undefined
      }
      record_esign_template_source_cleanup: {
        Args: {
          p_actor_id: string
          p_error_code: string | null
          p_org_id: string
          p_outcome: string
          p_storage_path: string
          p_template_id: string
        }
        Returns: string
      }
      record_verified_esign_template_source: {
        Args: {
          p_actor_id: string
          p_content_type: string
          p_org_id: string
          p_source_filename: string
          p_source_id: string
          p_source_sha256: string
          p_source_size_bytes: number
          p_storage_path: string
        }
        Returns: string
      }
      release_esign_request_void: {
        Args: { p_claim_token: string; p_org_id: string; p_request_id: string }
        Returns: string
      }
      release_esign_signer_reminder: {
        Args: {
          p_claim_token: string
          p_org_id: string
          p_request_id: string
          p_signer_id: string
        }
        Returns: string
      }
      soft_delete_esign_template: {
        Args: {
          p_actor_id: string
          p_confirm_recent_sends: boolean
          p_org_id: string
          p_template_id: string
        }
        Returns: {
          outcome: string
          recent_send_count: number
        }[]
      }
      set_org_esign_sending_enabled: {
        Args: { p_actor_id: string; p_enabled: boolean; p_org_id: string }
        Returns: undefined
      }
      upsert_org_esign_integration: {
        Args: {
          p_actor_id: string
          p_api_key: string
          p_api_key_last_four: string
          p_callback_secret_hash: string
          p_client_id: string
          p_key: string
          p_org_id: string
        }
        Returns: undefined
      }
      fn_apply_ai_disposition_with_review: {
        Args: {
          p_ai_reason: string
          p_conversation_id: string
          p_disposition: string
          p_property_id: string
          p_source_inbound_message_id: string
        }
        Returns: Json
      }
      fn_confirm_ai_disposition_review: {
        Args: { p_review_id: string }
        Returns: Json
      }
      jitter_claim_dialer_batch: {
        Args: {
          p_batch_id: string
          p_external_id: string
          p_org_id: string
          p_request_hash: string
          p_session_id: string
        }
        Returns: Json
      }
      jitter_patch_dialer_batch_item: {
        Args: {
          p_claim_generation: number
          p_external_id: string
          p_item_id: string
          p_org_id: string
          p_request_hash: string
          p_session_id: string
          p_status: string
        }
        Returns: Json
      }
      jitter_upsert_call_recording: {
        Args: {
          p_call_activity_id: string
          p_duration_seconds: number | null
          p_error_code: string | null
          p_error_message: string | null
          p_external_id: string
          p_org_id: string
          p_request_hash: string
          p_status: string
          p_storage_path: string | null
        }
        Returns: Json
      }
      jitter_upsert_call_transcript: {
        Args: {
          p_call_activity_id: string
          p_error_code: string | null
          p_error_message: string | null
          p_external_id: string
          p_language: string | null
          p_org_id: string
          p_request_hash: string
          p_status: string
          p_summary: string | null
          p_summary_error_code: string | null
          p_summary_error_message: string | null
          p_summary_status: string
          p_text: string | null
        }
        Returns: Json
      }
      jitter_writeback_call_activity: {
        Args: {
          p_attempt_id: string
          p_body: Json
          p_callback_assignee_id: string | null
          p_external_id: string
          p_org_id: string
          p_request_hash: string
        }
        Returns: Json
      }
      assert_appointment_task_dnc_unlocked: {
        Args: { p_task_id: string }
        Returns: undefined
      }
      assert_contact_dnc_unlocked: {
        Args: { p_contact_id: string }
        Returns: undefined
      }
      assert_property_dnc_unlocked: {
        Args: { p_property_id: string }
        Returns: undefined
      }
      sms_inbox_thread_snapshot: {
        Args: { p_cutoff: string }
        Returns: Json
      }
      sms_inbox_thread_page_snapshot: {
        Args: {
          p_assignee_id?: string | null
          p_cutoff: string
          p_filter?: string
          p_hide_noise?: boolean
          p_include_thread_id?: string | null
          p_limit?: number
          p_offset?: number
        }
        Returns: Json
      }
      resolve_sms_conversation_org: {
        Args: { p_conversation_id: string }
        Returns: string
      }
      claim_paid_property_enrichment: {
        Args: { p_org_id: string; p_property_id: string }
        Returns: boolean
      }
      claim_authorized_cass_job_start: {
        Args: {
          p_claim_token: string | null
          p_job_id: string
          p_org_id: string
        }
        Returns: string
      }
      claim_cass_property_lookup: {
        Args: {
          p_job_id: string
          p_org_id: string
          p_property_id: string
          p_provider_id: string
        }
        Returns: {
          action: string
          error_message: string
          outcome: string
          result_payload: Json
        }[]
      }
      claim_csv_import_retry: {
        Args: { p_job_id: string }
        Returns: boolean
      }
      claim_csv_import_line_type_lookup: {
        Args: {
          p_job_id: string
          p_org_id: string
          p_phone_e164: string
        }
        Returns: {
          action: string
          line_type: string
          outcome: string
        }[]
      }
      complete_csv_import_line_type_lookup: {
        Args: {
          p_job_id: string
          p_last_error?: string | null
          p_line_type: string
          p_org_id: string
          p_outcome: string
          p_phone_e164: string
          p_provider_http_status?: number | null
          p_state: string
        }
        Returns: undefined
      }
      create_authorized_cass_job: {
        Args: {
          p_auto_start: boolean
          p_blocked_reason: string | null
          p_created_by: string | null
          p_org_id: string
          p_parent_job_id: string | null
          p_property_ids: string[]
          p_purpose: string
          p_related_import_id: string | null
          p_request_key: string
          p_source_job_id: string | null
        }
        Returns: {
          claim_token: string
          created: boolean
          job_id: string
          job_status: string
        }[]
      }
      create_skip_trace_retry_job: {
        Args: { p_parent_job_id: string; p_property_ids: string[] }
        Returns: {
          created: boolean
          job_id: string
        }[]
      }
      complete_cass_property_lookup: {
        Args: {
          p_error_message: string | null
          p_job_id: string
          p_org_id: string
          p_outcome: string | null
          p_property_id: string
          p_result_payload: Json | null
          p_state: string
        }
        Returns: boolean
      }
      fail_authorized_cass_job_start: {
        Args: {
          p_claim_token: string
          p_job_id: string
          p_message: string
          p_org_id: string
        }
        Returns: boolean
      }
      checkpoint_csv_import_property_outcome: {
        Args: {
          p_csv_import_id: string
          p_existing_patch?: Json
          p_existing_property_id?: string | null
          p_job_id: string
          p_org_id: string
          p_property: Json
          p_source_row_index: number
        }
        Returns: {
          compliance_locked: boolean
          original_outcome: string
          property_id: string
        }[]
      }
      capture_sendillo_sms_health_snapshot: {
        Args: { p_captured_at?: string }
        Returns: {
          captured_at: string
          payload: Json
        }[]
      }
      compute_sendillo_sms_health: { Args: never; Returns: Json }
      upsert_skip_trace_credit_snapshot: {
        Args: { p_captured_at: string; p_credits: number }
        Returns: boolean
      }
      campaign_kpis: {
        Args: { p_campaign_id: string }
        Returns: {
          attempted: number
          audience: number
          delivered: number
          delivered_rate: number
          failed: number
          failed_rate: number
          opt_out_rate: number
          opted_out: number
          replied: number
          reply_rate: number
        }[]
      }
      count_phone_coverage_stats: {
        Args: never
        Returns: {
          denominator: number
          numerator: number
        }[]
      }
      dashboard_summary: { Args: never; Returns: Json }
      fail_csv_import_workflow: {
        Args: {
          p_csv_import_id: string
          p_job_id: string
          p_message: string
          p_org_id: string
        }
        Returns: Json
      }
      record_csv_import_consents: {
        Args: { p_job_id: string; p_org_id: string }
        Returns: number
      }
      get_leads_board_page: {
        Args: {
          p_assignee_id: string | null
          p_attention: string | null
          p_cursor_due_at: string | null
          p_cursor_id: string | null
          p_day_end: string
          p_day_start: string
          p_hot_only: boolean
          p_limit: number
          p_motivation: string
          p_no_active_sequence: boolean
          p_search_tokens: string[]
          p_skip_traced: boolean | null
          p_status: string
          p_unassigned: boolean
          p_urgency: string
        }
        Returns: {
          rows: Json
          snapshot_generation: string
          total_count: number
        }[]
      }
      get_leads_board_urgency_counts: {
        Args: {
          p_assignee_id: string | null
          p_attention: string | null
          p_day_end: string
          p_day_start: string
          p_hot_only: boolean
          p_motivation: string
          p_no_active_sequence: boolean
          p_search_tokens: string[]
          p_skip_traced: boolean | null
          p_unassigned: boolean
        }
        Returns: {
          all_count: number
          no_action_count: number
          overdue_count: number
          scheduled_count: number
          today_count: number
        }[]
      }
      get_leads_board_stage_counts: {
        Args: never
        Returns: {
          status: string
          total_count: number
        }[]
      }
      set_lead_next_action: {
        Args: {
          p_due_at: string
          p_idempotency_key: string
          p_property_id: string
        }
        Returns: {
          assignee_id: string
          created_at: string
          created_by: string
          due_at: string
          id: string
          org_id: string
          related_property_id: string
          status: string
          title: string
          type: string
          was_created: boolean
        }[]
      }
      outbound_sms_metrics: {
        Args: {
          p_campaign_id?: string | null
          p_day_end?: string | null
          p_day_start?: string | null
          p_now?: string | null
          p_org_id?: string | null
        }
        Returns: {
          delivered: number
          delivered_without_sent_at_today: number
          due_queued: number
          failed: number
          failed_after_handoff: number
          failed_today: number
          handed_off_via_sent_at_today: number
          last_scheduled_for: string | null
          next_scheduled_for: string | null
          outbound_rows: number
          paused: number
          pending: number
          queued: number
          sent: number
        }[]
      }
      delete_contact: {
        Args: { p_contact_id: string; p_reason: string }
        Returns: undefined
      }
      create_promote_leads_job: {
        Args: {
          p_idempotency_key: string
          p_org: string
          p_property_ids: string[]
        }
        Returns: Json
      }
      fail_promote_leads_item: {
        Args: { p_error: string; p_item_key: string; p_job: string }
        Returns: Json
      }
      fail_promote_leads_workflow_start: {
        Args: { p_error: string; p_job: string }
        Returns: Json
      }
      fail_promote_leads_workflow: {
        Args: { p_claim_token: string; p_error: string; p_job: string }
        Returns: Json
      }
      process_promote_leads_item: {
        Args: { p_item_key: string; p_job: string }
        Returns: Json
      }
      promote_leads_recompute_job: {
        Args: { p_job: string }
        Returns: Json
      }
      retry_promote_leads_job: {
        Args: { p_idempotency_key: string; p_parent_job: string }
        Returns: Json
      }
      delete_oauth_tokens: {
        Args: { p_provider: string; p_user_id: string }
        Returns: undefined
      }
      get_oauth_token: {
        Args: {
          p_key: string
          p_provider: string
          p_token_type: string
          p_user_id: string
        }
        Returns: {
          access_token: string
          access_token_expires_at: string
          external_account_id: string
          refresh_token: string
          scopes: string[]
        }[]
      }
      hugo_apply_access: {
        Args: {
          p_access_expires_at: string | null
          p_config: Json
          p_email: string
          p_operation_id: string
          p_role: string
          p_status: string
        }
        Returns: Json
      }
      hugo_preflight_access_operation: {
        Args: {
          p_access_expires_at: string | null
          p_config: Json
          p_email: string
          p_operation_id: string
          p_role: string
          p_status: string
        }
        Returns: Json
      }
      hugo_record_identity_provision_failure: {
        Args: {
          p_access_expires_at: string | null
          p_config: Json
          p_email: string
          p_operation_id: string
          p_role: string
          p_status: string
        }
        Returns: Json
      }
      hugo_delete_identity: {
        Args: { p_email: string; p_operation_id: string }
        Returns: Json
      }
      hugo_inspect_access: {
        Args: { p_email: string }
        Returns: Json
      }
      hugo_list_access: {
        Args: Record<PropertyKey, never>
        Returns: {
          access_expires_at: string | null
          app_user_id: string
          config: Json
          email: string
          has_durable_activity: boolean
          role: string
          status: string
        }[]
      }
      hugo_prepare_pristine_delete: {
        Args: { p_email: string; p_operation_id: string }
        Returns: Json
      }
      ensure_sms_conversation_id: {
        Args: { p_contact_id: string; p_property_id: string | null }
        Returns: string
      }
      merge_duplicate_properties: {
        Args: { keeper_id: string; loser_id: string }
        Returns: undefined
      }
      persist_campaign_delivery_settings: {
        Args: {
          p_campaign_id: string
          p_from_address: string
          p_org_id: string
          p_provider: string
          p_provider_campaign_id?: string | null
          p_provider_campaign_name?: string | null
          p_sender_number: string
        }
        Returns: undefined
      }
      sms_thread_candidate_properties: {
        Args: { p_business_phone?: string | null; p_contact_id: string }
        Returns: {
          conversation_id: string | null
          latest_at: string
          property_id: string
        }[]
      }
      increment_sms_inbound_intent_duplicate: {
        Args: { p_intent_id: string; p_last_provider_message_id: string }
        Returns: undefined
      }
      reset_tenant_tables: { Args: never; Returns: undefined }
      upsert_oauth_token: {
        Args: {
          p_access: string
          p_account: string
          p_expires_at: string
          p_key: string
          p_provider: string
          p_refresh: string
          p_scopes: string[]
          p_token_type: string
          p_user_id: string
        }
        Returns: undefined
      }
    }
    Enums: {
      esign_delivery_state: "sending" | "sent" | "send_unknown" | "failed"
      esign_request_claim_outcome:
        "created" | "existing_same_payload" | "intent_conflict" | "blocked"
      esign_request_status:
        "awaiting" | "viewed" | "signed" | "declined" | "voided" | "error"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      esign_delivery_state: ["sending", "sent", "send_unknown", "failed"],
      esign_request_claim_outcome: [
        "created",
        "existing_same_payload",
        "intent_conflict",
        "blocked",
      ],
      esign_request_status: [
        "awaiting",
        "viewed",
        "signed",
        "declined",
        "voided",
        "error",
      ],
    },
  },
} as const
