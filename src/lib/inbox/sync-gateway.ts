import "server-only";
import { InboxHttpError } from "./http-error";

export type InboxSyncTarget = { kind: "known_conversation" | "unknown_sender"; id: string };
export type InboxSession = { userId: string; sessionId: string; expiresAt: number };
export type InboxAccess = { sessionActive: boolean; activeMembershipCount: number; status: "active" | "suspended" | "revoked"; epoch: string; expiresAt: number | null; deletionPrepared: boolean };
export interface DurableInboxScope {
  id: string; orgId: string; userId: string; sessionId: string; accessEpoch: string;
  generation: string; expiresAt: number; createdAt?: number; targets: readonly InboxSyncTarget[];
  handles: (string | null)[];
}
/** Implement with durable database state. No process-local fallback is permitted.
 * getAccess must revalidate current session revocation as well as membership.
 * Every method must honor signal and fail if its authorization/storage check is unavailable.
 */
export interface InboxSyncRepository {
  authenticate(request: Request, signal: AbortSignal): Promise<InboxSession | null>;
  /** Resolve global active membership count with current expiration/deletion/status semantics.
   * Exactly one active org must exist and equal orgId; unknown epoch or ambiguous membership denies.
   */
  getAccess(session: InboxSession, orgId: string, signal: AbortSignal): Promise<InboxAccess | null>;
  getScope(id: string, signal: AbortSignal): Promise<DurableInboxScope | null>;
  /** Atomically compare current handle AND scope/auth identity; scope must remain active.
   * Return false on conflict, expiration, replacement, revoked access or unavailable authority.
   */
  bindHandle(scope: DurableInboxScope, partitionIndex: number, expectedHandle: string | null, nextHandle: string, signal: AbortSignal): Promise<boolean>;
}
/** Canonical filter syntax is implemented/validated by the durable repository.
 * Unknown fields must fail; never interpolate filter values into SQL.
 */
export type InboxWorksetRequest = {
  orgId: string; filter: Readonly<Record<string, unknown>>;
  cursor: string | null; limit: number;
  /** Optional old generation to replace atomically; must belong to this same org/user/session. */
  replacesScopeId?: string;
};
export interface CreatedInboxWorkset extends DurableInboxScope { createdAt: number; nextCursor: string | null; refreshed: boolean }
export interface InboxWorksetRepository extends InboxSyncRepository {
  /** One consistent DB operation: reauthorize current session + exactly one global active
   * membership, validate canonical filter/cursor binding, resolve <=500 ordered typed IDs,
   * persist immutable scope with epoch/generation/expiry. Enforce generation rate (1/sec),
   * at most two live generations, and <=15min scope TTL. No arbitrary client-selected IDs.
   * Creation must never invent an epoch when permission-writer coverage is unavailable.
   */
  createScope(session: InboxSession, request: InboxWorksetRequest, signal: AbortSignal): Promise<CreatedInboxWorkset>;
}
export interface InboxGatewayOptions {
  repository: InboxSyncRepository;
  /** Fixed private upstream configuration. Never populated from browser query parameters. */
  electricUrl: string;
  projectionTable: string;
  upstreamHeaders?: Readonly<Record<string,string>>;
  fetch?: typeof fetch;
  maxResponseBytes?: number;
  maxUpstreamUrlBytes?: number;
  now?: () => number;
}
const columns = "org_id,target_kind,target_id,name,context,preview,time_label,outcome_label,assigned_label,unread";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const noStore = { "cache-control": "private, no-store", "vary": "Cookie, Authorization" };
class Denied extends Error { constructor(readonly status: number) {super("Inbox synchronization unavailable");} }
function validTargets(targets: readonly InboxSyncTarget[]) {
  if(!Array.isArray(targets)||targets.length>500) return false;
  const keys=new Set<string>();
  for(const target of targets) {
    if(!target||!uuid.test(target.id)||!["known_conversation","unknown_sender"].includes(target.kind))return false;
    const key=`${target.kind}:${target.id}`;if(keys.has(key))return false;keys.add(key);
  }
  return true;
}
/** Long-poll gateway core; mount only with a real durable repository and approved hosting.
 * It exposes only the flattened allowlisted projection. Canonical summary JSON is excluded.
 */
export function createInboxSyncGateway(options: InboxGatewayOptions) {
  const electric=new URL(options.electricUrl);
  if(!["http:","https:"].includes(electric.protocol)||electric.username||electric.password||electric.search||electric.hash)throw Error("Invalid private Electric endpoint");
  if(!/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/.test(options.projectionTable))throw Error("Invalid fixed projection table");
  const maxBytes=options.maxResponseBytes??2_000_000, maxUrl=options.maxUpstreamUrlBytes??65_536;
  if(!Number.isInteger(maxBytes)||maxBytes<1||maxBytes>2_000_000||!Number.isInteger(maxUrl)||maxUrl<1||maxUrl>65_536)throw Error("Invalid sync limits");
  const now=options.now??Date.now, repository=options.repository;
  return async function GET(request:Request,scopeId:string):Promise<Response> {
    const started=now();const leaseController=new AbortController();
    let timer=setTimeout(()=>leaseController.abort(),15_000);
    const signal=AbortSignal.any([request.signal,leaseController.signal]);
    let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
    const guard=()=>{if(signal.aborted||now()>=started+15_000)throw new Denied(503);};
    try {
      if(request.method!=="GET"||!uuid.test(scopeId))throw new Denied(400);
      const authenticated=await repository.authenticate(request,signal);guard();
      const session=authenticated?{...authenticated}:null;
      if(!session||!uuid.test(session.userId)||!session.sessionId||!Number.isFinite(session.expiresAt)||session.expiresAt<=now())throw new Denied(401);
      const stored=await repository.getScope(scopeId,signal);guard();
      const scope=stored ? {...stored,handles:Array.isArray(stored.handles)?[...stored.handles]:stored.handles,targets:Array.isArray(stored.targets)?stored.targets.map(target=>({...target})):stored.targets} : null;
      if(!scope||scope.id!==scopeId||!uuid.test(scope.orgId)||scope.userId!==session.userId||scope.sessionId!==session.sessionId)throw new Denied(403);
      if(!scope.generation||!scope.accessEpoch||!Number.isFinite(scope.expiresAt)||scope.expiresAt<=now() || (scope.createdAt!==undefined && (!Number.isFinite(scope.createdAt) || scope.expiresAt<scope.createdAt || scope.expiresAt-scope.createdAt>900000)))throw new Denied(410);
      if(!validTargets(scope.targets) || !Array.isArray(scope.handles) || scope.handles.length !== Math.max(1,Math.ceil(scope.targets.length/100)) || scope.handles.some(handle=>handle!==null && (typeof handle!=="string" || handle.length>256)))throw new Denied(503);
      // Copy repository-owned membership so an adapter cannot mutate the predicate during awaits.
      const targets=scope.targets.map(target=>({...target}));
      const authorize=async()=> {
        guard();
        const currentScope=await repository.getScope(scope.id,signal);guard();
        if(!currentScope || ["id","orgId","userId","sessionId","accessEpoch","generation","expiresAt","createdAt"].some(key=>currentScope[key as keyof DurableInboxScope]!==scope[key as keyof DurableInboxScope]) || JSON.stringify(currentScope.targets)!==JSON.stringify(targets))throw new Denied(403);
        if(session.expiresAt<=now())throw new Denied(401);
        if(scope.expiresAt<=now())throw new Denied(410);
        const access=await repository.getAccess(session,scope.orgId,signal);guard();
        if(!access||!access.sessionActive||access.activeMembershipCount!==1||access.status!=="active"||access.deletionPrepared||access.epoch!==scope.accessEpoch||
          (access.expiresAt!==null&&(!Number.isFinite(access.expiresAt)||access.expiresAt<=now())))throw new Denied(403);
        return Math.min(started+15000,session.expiresAt,scope.expiresAt,access.expiresAt??Infinity);
      };
      const deadline=await authorize();
      clearTimeout(timer);timer=setTimeout(()=>leaseController.abort(),Math.max(0,deadline-now()));
      const url=new URL(request.url), allowed=new Set(["offset","handle","live","cursor","log","partition"]);
      for(const key of url.searchParams.keys())if(!allowed.has(key)||url.searchParams.getAll(key).length!==1)throw new Denied(400);
      const partitionRaw=url.searchParams.get("partition")??"0";
      if(!/^[0-4]$/.test(partitionRaw))throw new Denied(400);
      const partition=Number(partitionRaw);
      if(partition>=scope.handles.length)throw new Denied(400);
      const partitionTargets=targets.slice(partition*100,(partition+1)*100);
      const expectedHandle=scope.handles[partition];
      const offset=url.searchParams.get("offset")??"-1", handle=url.searchParams.get("handle");
      if(!/^(-1|\d+_(\d+|inf))$/.test(offset)||offset.length>64)throw new Denied(400);
      if((handle&&handle!==expectedHandle)||(offset!=="-1"&&!handle))throw new Denied(403);
      if(url.searchParams.has("live")&&url.searchParams.get("live")!=="true")throw new Denied(400);
      if(url.searchParams.has("log")&&url.searchParams.get("log")!=="full")throw new Denied(400);
      if((url.searchParams.get("cursor")?.length??0)>256)throw new Denied(400);
      const upstream=new URL(electric);
      for(const [key,value]of url.searchParams)if(key!=="partition")upstream.searchParams.set(key,value);
      upstream.searchParams.set("offset",offset);upstream.searchParams.set("table",options.projectionTable);
      upstream.searchParams.set("columns",columns);upstream.searchParams.set("replica","default");
      const predicates:string[]=[];let parameter=2;
      upstream.searchParams.set("params[1]",scope.orgId);
      for(const kind of ["known_conversation","unknown_sender"] as const) {
        const members=partitionTargets.filter(target=>target.kind===kind);if(!members.length)continue;
        const positions=members.map(target=>{const index=parameter++;upstream.searchParams.set(`params[${index}]`,target.id);return `$${index}`;});
        predicates.push(`(target_kind = '${kind}' AND target_id IN (${positions.join(",")}))`);
      }
      upstream.searchParams.set("where",`org_id = $1 AND (${predicates.join(" OR ")||"FALSE"})`);
      if(new TextEncoder().encode(upstream.href).length>maxUrl)throw new Denied(413);
      guard();if(now()>=deadline)throw new Denied(403);
      const upstreamResponse=await (options.fetch??fetch)(upstream,{signal,headers:options.upstreamHeaders,redirect:"error",cache:"no-store"});
      reader=upstreamResponse.body?.getReader();const chunks:Uint8Array[]=[];let bytes=0;
      if(reader)for(;;) {guard();if(now()>=deadline)throw new Denied(403);const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>maxBytes)throw new Denied(413);chunks.push(part.value);}
      await authorize();if(now()>=deadline)throw new Denied(403);
      const next=upstreamResponse.headers.get("electric-handle");
      if(next) {
        if(next.length>256||!await repository.bindHandle(scope,partition,expectedHandle,next,signal))throw new Denied(409);
        await authorize();if(now()>=deadline)throw new Denied(403);
      }
      // Never forward arbitrary upstream headers or diagnostic/error bodies.
      if(!upstreamResponse.ok&&upstreamResponse.status!==409)throw new Denied(503);
      const headers:Record<string,string>={...noStore,"content-type":"application/json"};
      for(const key of ["electric-handle","electric-offset","electric-schema","electric-cursor","electric-up-to-date"]){const value=upstreamResponse.headers.get(key);if(value!==null)headers[key]=value;}
      const body=new Uint8Array(bytes);let position=0;for(const chunk of chunks){body.set(chunk,position);position+=chunk.length;}
      guard();if(now()>=deadline)throw new Denied(403);
      return new Response(upstreamResponse.status===204?null:body,{status:upstreamResponse.status,headers});
    } catch(error) {leaseController.abort();void reader?.cancel().catch(()=>{});return Response.json({error:"Inbox synchronization unavailable"},{status:error instanceof Denied || error instanceof InboxHttpError ? error.status : 503,headers:noStore});}
    finally {clearTimeout(timer);reader?.releaseLock();}
  };
}
