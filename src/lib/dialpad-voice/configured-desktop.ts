'use server';
import {getAcquisitionRoster} from '@/lib/my-leads/queries';
import {createDialpadVoiceAdminClient} from './database';
import type {ConfiguredStartDatabase} from './configured-start-database';
import {DialpadVoiceClient} from './client';
import {verifyDialpadInventory} from './verified-inventory';

type Input={grantId:string;connectionVersion:number;bindingRevision:number;grantRevision:number};
type Device={id:string;label:string;type:'native';readiness:'unproven'};
/** Lists registered devices only. Registration is never online or media readiness. */
export async function listMyDialpadDesktopDevices(input:Input):Promise<{ok:true;devices:Device[]}|{ok:false;error:string}>{
 if(process.env.DIALPAD_CONFIGURED_START_ENABLED!=='true')return{ok:false,error:'disabled'};
 if(!input||typeof input.grantId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.grantId)||![input.connectionVersion,input.bindingRevision,input.grantRevision].every(n=>Number.isSafeInteger(n)&&n>0))return{ok:false,error:'invalid_input'};
 try{
  const {viewer,roster}=await getAcquisitionRoster();
  if(!roster.settings.enabled||!roster.members.some(m=>m.id===viewer.userId&&m.active&&m.acquisitionsEnabled))return{ok:false,error:'forbidden'};
  const db=createDialpadVoiceAdminClient<ConfiguredStartDatabase>();
  const connection=await db.from('dialpad_org_connections').select('*').eq('org_id',viewer.orgId).maybeSingle();const c=connection.data;
  if(connection.error||!c||c.org_id!==viewer.orgId||!c.enabled||!c.verified_at||c.config_version!==input.connectionVersion||!/^env:DIALPAD_[A-Z0-9_]{1,119}$/.test(c.credential_reference))return{ok:false,error:'configuration_unavailable'};
  const binding=await db.from('dialpad_member_bindings').select('*').eq('org_id',viewer.orgId).eq('member_user_id',viewer.userId).is('revoked_at',null).maybeSingle();const b=binding.data;
  if(binding.error||!b||b.org_id!==viewer.orgId||b.member_user_id!==viewer.userId||b.revoked_at!==null||b.connection_id!==c.id||b.connection_version!==c.config_version||b.revision!==input.bindingRevision)return{ok:false,error:'binding_unavailable'};
  const grant=await db.from('dialpad_number_grants').select('*').eq('org_id',viewer.orgId).eq('binding_id',b.id).eq('id',input.grantId).is('revoked_at',null).maybeSingle();const g=grant.data;
  if(grant.error||!g||g.org_id!==viewer.orgId||g.binding_id!==b.id||g.revoked_at!==null||g.revision!==input.grantRevision)return{ok:false,error:'grant_unavailable'};
  const member=await db.auth.admin.getUserById(viewer.userId);const email=member.data.user?.email;
  if(member.error||!email||member.data.user?.id!==viewer.userId)return{ok:false,error:'member_unavailable'};
  const provider=new DialpadVoiceClient(process.env[c.credential_reference.slice(4)]??'');
  const inventory=await verifyDialpadInventory(provider,{orgId:viewer.orgId,providerCompanyId:c.provider_company_id,providerUserId:b.provider_user_id,memberEmail:email});
  if(!inventory.inventory.callers.some(n=>n.number===g.number_e164&&n.identity.type===g.identity_type&&n.identity.id===g.provider_identity_id))return{ok:false,error:'grant_not_verified'};
  const devices:Device[]=[];const ids=new Set<string>();const cursors=new Set<string>();let cursor:string|undefined;
  for(let page=0;page<20;page++){
   const raw:unknown=await provider.listUserDevices(b.provider_user_id,cursor);
   if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('invalid');const envelope=raw as Record<string,unknown>;
   if(!Array.isArray(envelope.items))throw Error('invalid');
   for(const item of envelope.items){
    if(!item||typeof item!=='object'||Array.isArray(item))throw Error('invalid');const d=item as Record<string,unknown>;
    if(typeof d.id!=='string'||!d.id.trim()||d.id.length>512||/[\r\n]/.test(d.id)||d.user_id!==b.provider_user_id||typeof d.type!=='string'||ids.has(d.id))throw Error('invalid');ids.add(d.id);
    if(d.type==='native')devices.push({id:d.id,label:`Dialpad desktop ${devices.length+1}`,type:'native',readiness:'unproven'});
   }
   if(envelope.cursor===undefined||envelope.cursor===null||envelope.cursor==='')return{ok:true,devices};
   if(typeof envelope.cursor!=='string'||envelope.cursor.length>4096||cursors.has(envelope.cursor))throw Error('incomplete');cursor=envelope.cursor;cursors.add(cursor);
  }
  return{ok:false,error:'device_inventory_unavailable'};
 }catch{return{ok:false,error:'device_inventory_unavailable'};}
}
