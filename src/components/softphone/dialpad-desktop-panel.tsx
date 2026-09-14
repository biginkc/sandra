'use client';
import {useEffect,useRef,useState} from 'react';
import {startConfiguredDialpadCall} from '@/lib/dialpad-voice/configured-start';
import {listMyDialpadDesktopDevices} from '@/lib/dialpad-voice/configured-desktop';
import {hangupConfiguredDialpadCall} from '@/lib/dialpad-voice/configured-hangup';
import {getMyDialpadCallStatus,getMyActiveDialpadCall} from '@/lib/dialpad-voice/call-status';
import type {DialpadCallerIdentity} from '@/lib/dialpad-voice/assignments';
export type DialpadCallerOption = Readonly<{provider:'dialpad';grantId:string;grantRevision:number;bindingRevision:number;connectionVersion:number;phoneE164:string;identity:DialpadCallerIdentity}>;
type Device={id:string;label:string;type:'native';readiness:'unproven'};
/** Desktop owns audio and call controls. This view never infers connection or
 * tracking credit from a successful start request. */
export function DialpadDesktopPanel({propertyId,caller,leadName,leadAddress,onCancel,initialCall}:{propertyId:string;caller?:DialpadCallerOption;leadName:string;leadAddress?:string;onCancel:()=>void;initialCall?:{intentId:string;status:string}}) {
 const [devices,setDevices]=useState<Device[]>([]),[deviceId,setDeviceId]=useState('');
 const [loading,setLoading]=useState(!initialCall),[error,setError]=useState<string|null>(null);
 const [status,setStatus]=useState<string|null>(initialCall?.status ?? null),[pending,setPending]=useState(false);
 const [hangupRequested,setHangupRequested]=useState(false);
 const hangupLock=useRef(false);
 const [intentId,setIntentId]=useState<string|null>(initialCall?.intentId ?? null);
 const requestId=useRef<string|null>(null),attempted=useRef(!!initialCall);
 useEffect(()=>{if(initialCall||!caller)return;let active=true;setLoading(true);
  void listMyDialpadDesktopDevices({grantId:caller.grantId,grantRevision:caller.grantRevision,bindingRevision:caller.bindingRevision,connectionVersion:caller.connectionVersion}).then(result=>{
   if(!active)return;if(result.ok)setDevices(result.devices);else setError('Could not verify your Dialpad desktop devices.');
  }).catch(()=>{if(active)setError('Could not verify your Dialpad desktop devices.');}).finally(()=>{if(active)setLoading(false);});
  return()=>{active=false;};
 },[caller,initialCall]);
 useEffect(()=>{
  if(!intentId||status==='completed'||status==='failed'||status==='cancelled')return;
  let active=true;let timer:ReturnType<typeof setTimeout>;
  const poll=async()=>{try{const result=await getMyDialpadCallStatus({intentId});if(active&&result.ok)setStatus(result.status);}catch{/* Keep unknown status, never retry the call. */}finally{if(active)timer=setTimeout(()=>void poll(),5000);}};
  void poll();return()=>{active=false;clearTimeout(timer);};
 },[intentId,status]);
 const recover=async()=>{
  try{const result=await getMyActiveDialpadCall();if(result.ok&&result.call&&result.call.propertyId===propertyId){setIntentId(result.call.intentId);setStatus(result.call.status);}}
  catch{/* Recovery failure must not release an uncertain request. */}
 };
 const start=async()=>{
  if(!caller||attempted.current||!devices.some(device=>device.id===deviceId))return;
  attempted.current=true;requestId.current??=crypto.randomUUID();setPending(true);setError(null);
  try{
   const result=await startConfiguredDialpadCall({propertyId,grantId:caller.grantId,grantRevision:caller.grantRevision,bindingRevision:caller.bindingRevision,connectionVersion:caller.connectionVersion,deviceId,idempotencyKey:requestId.current});
   if(result.ok){setStatus(result.status);setIntentId(result.intentId);}
   else {setStatus('unconfirmed');setError('The app could not confirm the call request. Check Dialpad before calling again.');await recover();}
  }catch{setStatus('unconfirmed');setError('The call request may have reached Dialpad. Check Dialpad before calling again.');await recover();}
  finally{setPending(false);}
 };
 const hangup=async()=>{
  if(!intentId||hangupLock.current)return;hangupLock.current=true;setHangupRequested(true);
  try{const result=await hangupConfiguredDialpadCall({intentId});
   if(!result.ok||result.status==='hangup_unconfirmed')setError('Could not confirm hangup. End the call in Dialpad; the app will keep checking its status.');
  }catch{setError('Could not confirm hangup. End the call in Dialpad; the app will keep checking its status.');}
 };
 return <section className="p-5" aria-label="Dialpad desktop call">
  <h2 className="text-base font-bold">Call {leadName}</h2>
  {leadAddress&&<p className="mt-1 text-sm text-stone-600">{leadAddress}</p>}
  <p className="mt-2 text-sm">Your Dialpad desktop app handles audio and call controls. Open it and select your signed-in device below.</p>
  <p className="mt-2 text-xs text-stone-600">Keep Dialpad open on the selected computer. Live coaching is not available in this integration yet.</p>
  {!status&&!pending&&<>
   {loading?<p role="status">Checking desktop devices…</p>:devices.length===0?<p>No verified desktop device is available. Open Dialpad and reopen this call setup.</p>:<label className="mt-3 block text-sm">Dialpad desktop<select aria-label="Dialpad desktop" value={deviceId} onChange={event=>setDeviceId(event.target.value)} className="mt-1 block w-full rounded border p-2"><option value="">Choose a device</option>{devices.map(device=><option key={device.id} value={device.id}>{device.label}</option>)}</select></label>}
   <button type="button" disabled={loading||!deviceId||!!error} onClick={()=>void start()} className="mt-3 rounded bg-emerald-700 px-3 py-2 text-white disabled:opacity-50">Call with Dialpad</button>
   <button type="button" onClick={onCancel} className="ml-3 px-3 py-2">Back</button>
  </>}
  {pending&&<p role="status" className="mt-3">Sending call request…</p>}
  {status&&<p role="status" className="mt-3">{status==='failed'?'The call request failed.':status==='cancelled'?'The call request was cancelled.':status==='completed'?'Dialpad reports this call has ended.':'Call status is not confirmed here. Check the Dialpad desktop app to continue or end the call.'}</p>}
  {status&&!intentId&&<button type="button" onClick={()=>void recover()} className="mt-3 rounded border px-3 py-2">Check existing call</button>}
  {intentId&&status!=='completed'&&status!=='failed'&&status!=='cancelled'&&<button type="button" disabled={hangupRequested} onClick={()=>void hangup()} className="mt-3 rounded border border-red-300 px-3 py-2 text-red-700">{hangupRequested?'Hangup requested; waiting for confirmation':'Request hangup'}</button>}
  {intentId&&<p className="mt-2 break-all text-xs text-stone-500">Call reference: {intentId}</p>}
  {error&&<p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
  {status==='failed'||status==='completed'||status==='cancelled'?<button type="button" onClick={onCancel} className="mt-3 px-3 py-2">Back to dialer</button>:null}
 </section>;
}
