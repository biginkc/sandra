import type { Json } from '@/lib/supabase/types';
import type { DialpadConfigurationDatabase } from './configuration-database';
type VerificationInsert={org_id:string;connection_id:string;connection_version:number;provider_company_id:string;member_user_id:string;provider_user_id:string;member_email_matched:boolean;callers:Json;verified_at:string};
export type ConfiguredStartDatabase=Omit<DialpadConfigurationDatabase,'public'>&{public:Omit<DialpadConfigurationDatabase['public'],'Tables'|'Functions'>&{
 Tables:DialpadConfigurationDatabase['public']['Tables']&{
  dialpad_inventory_verifications:{Row:VerificationInsert&{id:string};Insert:VerificationInsert;Update:never;Relationships:[]};
  dialpad_intent_configuration:{Row:{org_id:string;intent_id:string;grant_id:string;grant_revision:number;binding_revision:number;connection_version:number;device_id:string};Insert:never;Update:never;Relationships:[]};
 };
 Functions:DialpadConfigurationDatabase['public']['Functions']&{
 fn_record_dialpad_dispatch_response:{Args:{p_org_id:string;p_actor_id:string;p_intent_id:string;p_candidate_call_id:string};Returns:Json};
 fn_prepare_dialpad_configured_intent:{Args:{p_org_id:string;p_actor_id:string;p_property_id:string;p_intent_id:string;p_idempotency_key:string;p_grant_id:string;p_verification_id:string;p_device_id:string;p_device_verified_at:string;p_destination_e164:string};Returns:Json};
 fn_dispatch_configured_dialpad_intent:{Args:{p_org_id:string;p_actor_id:string;p_intent_id:string};Returns:Json};
 };
}};
