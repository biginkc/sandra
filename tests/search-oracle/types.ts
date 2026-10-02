export interface OracleProperty {
  id: string; org_id: string;
  address: string | null; city: string | null; state: string | null; zip: string | null;
  market: string | null; apn: string | null; mls_number: string | null;
  homeowner_contact_id: string | null; agent_contact_id: string | null;
  deleted_at: string | null; is_training: boolean; status: string;
}
export interface OracleContact {
  id: string; org_id: string;
  first_name: string | null; last_name: string | null; entity_name: string | null; email: string | null;
  phone_1: string | null; phone_2: string | null; phone_3: string | null;
}
export interface OracleMessage {
  id: string; org_id: string; property_id: string | null; contact_id: string | null;
  conversation_id: string | null; channel: string; direction: "inbound" | "outbound";
  body: string | null;
}
export interface OracleMembership {
  user_id: string; org_id: string; access_status: string;
  access_expires_at: string | null; deletion_prepared_at: string | null;
}
export interface OracleFixture {
  properties: OracleProperty[]; contacts: OracleContact[];
  messages: OracleMessage[]; memberships: OracleMembership[];
  users: { id: string; orgIds: string[] }[];
}
export interface OracleQuery { q: string; includeMessages: boolean; }
