import type { Json } from '@/lib/supabase/types';
import type { DialpadVoiceDatabase } from './database.generated';

// Narrow read/RPC contracts checked against the organization/configuration
// migrations. These do not replace the application's generated schema.
type ReadTable<Row> = { Row: Row; Insert: never; Update: never; Relationships: [] };
export type DialpadConfigurationDatabase = Omit<DialpadVoiceDatabase, 'public'> & {
  public: Omit<DialpadVoiceDatabase['public'], 'Tables' | 'Functions'> & {
    Tables: DialpadVoiceDatabase['public']['Tables'] & {
      dialpad_org_connections: ReadTable<{
        id: string; org_id: string; provider_company_id: string; enabled: boolean;
        config_version: number; verified_at: string | null; credential_reference: string;
      }>;
      dialpad_number_grants: ReadTable<{
        id: string; org_id: string; binding_id: string; revision: number; identity_type: string; provider_identity_id: string; number_e164: string; revoked_at: string | null;
      }>;
      dialpad_member_bindings: ReadTable<{
        id: string; org_id: string; member_user_id: string; provider_user_id: string; connection_id: string; connection_version: number; revision: number; revoked_at: string | null;
      }>;
    };
    Functions: DialpadVoiceDatabase['public']['Functions'] & {
      fn_replay_dialpad_member_configuration: {
        Args: { p_org_id: string; p_owner_user_id: string; p_member_user_id: string; p_provider_user_id: string;
          p_expected_connection_version: number; p_expected_binding_revision: number; p_selected_callers: Json; p_request_id: string };
        Returns: Json;
      };
      fn_configure_dialpad_member: {
        Args: {
          p_org_id: string; p_owner_user_id: string; p_member_user_id: string; p_connection_id: string;
          p_expected_connection_version: number; p_provider_company_id: string; p_provider_user_id: string;
          p_verified_at: string; p_callers: Json; p_selected_callers: Json;
          p_expected_binding_revision: number; p_request_id: string;
        };
        Returns: Json;
      };
    };
  };
};
