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
          daily_send_cap: number
          escalation_keywords: string[]
          id: string
          max_turns: number
          min_confidence: number
          model: string
          org_id: string
          system_prompt: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          business_hours_only?: boolean
          created_at?: string
          created_by?: string | null
          daily_send_cap?: number
          escalation_keywords?: string[]
          id?: string
          max_turns?: number
          min_confidence?: number
          model?: string
          org_id: string
          system_prompt: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          business_hours_only?: boolean
          created_at?: string
          created_by?: string | null
          daily_send_cap?: number
          escalation_keywords?: string[]
          id?: string
          max_turns?: number
          min_confidence?: number
          model?: string
          org_id?: string
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
          phone_2: string | null
          phone_3: string | null
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
          phone_2?: string | null
          phone_3?: string | null
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
          phone_2?: string | null
          phone_3?: string | null
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
          id: string
          market: string
          name: string
          org_id: string
          state: string
        }
        Insert: {
          created_at?: string
          id?: string
          market: string
          name: string
          org_id?: string
          state: string
        }
        Update: {
          created_at?: string
          id?: string
          market?: string
          name?: string
          org_id?: string
          state?: string
        }
        Relationships: [
          {
            foreignKeyName: "counties_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      csv_imports: {
        Row: {
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
            foreignKeyName: "csv_imports_org_id_fkey"
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
      messages: {
        Row: {
          body: string
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
          body: string
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
          body?: string
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
          metadata?: Json | null
          org_id?: string
          scheduled_for?: string | null
          property_id?: string | null
          provider?: string | null
          read_at?: string | null
          sent_at?: string | null
          status?: string
          subject?: string | null
          to_address?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "messages_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
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
          fips_code: string | null
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
          follow_up_at: string | null
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
          fips_code?: string | null
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
          follow_up_at?: string | null
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
          fips_code?: string | null
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
          follow_up_at?: string | null
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
      sms_templates: {
        Row: {
          id: string
          org_id: string
          name: string
          content: string
          category: string
          system_managed: boolean
          created_by: string | null
          created_at: string
          updated_at: string
          deleted_at: string | null
        }
        Insert: {
          id?: string
          org_id: string
          name: string
          content: string
          category?: string
          system_managed?: boolean
          created_by?: string | null
          created_at?: string
          updated_at?: string
          deleted_at?: string | null
        }
        Update: {
          id?: string
          org_id?: string
          name?: string
          content?: string
          category?: string
          system_managed?: boolean
          created_by?: string | null
          created_at?: string
          updated_at?: string
          deleted_at?: string | null
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
          revoked_at?: string | null
          secret_hash?: string
        }
        Relationships: []
      }
      webhook_events: {
        Row: {
          error_message: string | null
          event_type: string
          external_id: string
          id: string
          payload: Json
          processed_at: string | null
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
          payload: Json
          processed_at?: string | null
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
          payload?: Json
          processed_at?: string | null
          processing_status?: string
          provider?: string
          received_at?: string
          signature_verified?: boolean
        }
        Relationships: []
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
      dashboard_summary: { Args: never; Returns: Json }
      delete_contact: {
        Args: { p_contact_id: string; p_reason: string }
        Returns: undefined
      }
      merge_duplicate_properties: {
        Args: { keeper_id: string; loser_id: string }
        Returns: undefined
      }
      reset_tenant_tables: { Args: never; Returns: undefined }
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
