import type {DialpadVoiceDatabase} from './database.generated';
type Read<R>={Row:R;Insert:never;Update:never;Relationships:[]};
type Inbox=DialpadVoiceDatabase['public']['Tables']['dialpad_voice_event_inbox'];
export type EventConfigurationDatabase=Omit<DialpadVoiceDatabase,'public'>&{public:Omit<DialpadVoiceDatabase['public'],'Tables'>&{Tables:Omit<DialpadVoiceDatabase['public']['Tables'],'dialpad_voice_event_inbox'>&{
 dialpad_voice_event_inbox:Omit<Inbox,'Row'|'Insert'>&{Row:Inbox['Row']&{webhook_source_id:string|null};Insert:Inbox['Insert']&{webhook_source_id?:string|null}};
 dialpad_voice_webhook_sources:Read<{id:string;org_id:string;connection_id:string;connection_version:number;webhook_secret_reference:string}>;
 dialpad_intent_configuration:Read<{org_id:string;intent_id:string;connection_id:string;connection_version:number}>;
 dialpad_connection_revisions:Read<{org_id:string;connection_id:string;config_version:number;provider_company_id:string;credential_reference:string}>;
}}};
