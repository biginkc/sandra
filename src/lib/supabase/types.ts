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
          contact_id: string
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
          property_id: string
          provider: string
          provider_call_id: string | null
          raw_event_count: number
          recording_status: string
          started_at: string | null
          transcript_status: string
          updated_at: string
        }
        Insert: {
          contact_id: string
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
          property_id: string
          provider?: string
          provider_call_id?: string | null
          raw_event_count?: number
          recording_status?: string
          started_at?: string | null
          transcript_status?: string
          updated_at?: string
        }
        Update: {
          contact_id?: string
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
          property_id?: string
          provider?: string
          provider_call_id?: string | null
          raw_event_count?: number
          recording_status?: string
          started_at?: string | null
          transcript_status?: string
          updated_at?: string
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
      consent_events: {
        Row: {
          channel: string
          contact_id: string
          created_at: string
          event_type: string
          id: string
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
          occurred_at?: string
          org_id?: string
          source?: string | null
          source_detail?: Json | null
        }
        Relationships: [
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
      csv_imports: {
        Row: {
          county_id: string | null
          created_at: string
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
          error_class: string | null
          error_message: string | null
          id: string
          input_payload: Json | null
          job_id: string
          message_id: string | null
          output_payload: Json | null
          processed_at: string | null
          property_id: string | null
          retry_count: number
          status: string
        }
        Insert: {
          contact_id?: string | null
          error_class?: string | null
          error_message?: string | null
          id?: string
          input_payload?: Json | null
          job_id: string
          message_id?: string | null
          output_payload?: Json | null
          processed_at?: string | null
          property_id?: string | null
          retry_count?: number
          status?: string
        }
        Update: {
          contact_id?: string | null
          error_class?: string | null
          error_message?: string | null
          id?: string
          input_payload?: Json | null
          job_id?: string
          message_id?: string | null
          output_payload?: Json | null
          processed_at?: string | null
          property_id?: string | null
          retry_count?: number
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
            foreignKeyName: "job_items_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_items_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_items_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
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
          provider: string
          result: Json
        }
        Insert: {
          address_normalized: string
          cost_credits?: number
          created_at?: string
          id?: string
          match_count?: number
          provider: string
          result: Json
        }
        Update: {
          address_normalized?: string
          cost_credits?: number
          created_at?: string
          id?: string
          match_count?: number
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
      tasks: {
        Row: {
          assignee_id: string
          completed_at: string | null
          completed_by: string | null
          created_at: string
          created_by: string
          due_at: string
          google_calendar_event_id: string | null
          id: string
          org_id: string
          related_property_id: string
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
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          created_by: string
          due_at: string
          google_calendar_event_id?: string | null
          id?: string
          org_id: string
          related_property_id: string
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
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          created_by?: string
          due_at?: string
          google_calendar_event_id?: string | null
          id?: string
          org_id?: string
          related_property_id?: string
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
            foreignKeyName: "tasks_related_property_id_fkey"
            columns: ["related_property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
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
          timezone: string
          updated_at: string
          user_id: string
        }
        Insert: {
          channel: string
          created_at?: string
          enabled?: boolean
          timezone?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          channel?: string
          created_at?: string
          enabled?: boolean
          timezone?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
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
      delete_contact: {
        Args: { p_contact_id: string; p_reason: string }
        Returns: undefined
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
      [_ in never]: never
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
    Enums: {},
  },
} as const
