import {render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {beforeEach,describe,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({active:vi.fn(),devices:vi.fn(),start:vi.fn(),status:vi.fn()}));
vi.mock('@/lib/dialpad-voice/configured-hangup',()=>({hangupConfiguredDialpadCall:vi.fn(async()=>({ok:true,status:'hangup_requested'}))}));
vi.mock('@/lib/dialpad-voice/configured-desktop',()=>({listMyDialpadDesktopDevices:m.devices}));
vi.mock('@/lib/dialpad-voice/configured-start',()=>({startConfiguredDialpadCall:m.start}));
vi.mock('@/lib/dialpad-voice/call-status',()=>({getMyDialpadCallStatus:m.status,getMyActiveDialpadCall:m.active}));
import {DialpadDesktopPanel,type DialpadCallerOption} from './dialpad-desktop-panel';
const caller:DialpadCallerOption={provider:'dialpad',grantId:'grant',grantRevision:2,bindingRevision:3,connectionVersion:4,phoneE164:'+12025550101',identity:{type:'office',id:'301'}};
beforeEach(()=>{vi.resetAllMocks();m.active.mockResolvedValue({ok:true,call:null});m.devices.mockResolvedValue({ok:true,devices:[{id:'native',label:'Dialpad desktop 1',type:'native',readiness:'unproven'}]});m.start.mockResolvedValue({ok:true,intentId:'intent',status:'initiation_unconfirmed'});m.status.mockResolvedValue({ok:true,intentId:'intent',status:'initiation_unconfirmed'});});
const mount=()=>render(<DialpadDesktopPanel propertyId="property" caller={caller} leadName="Test lead" onCancel={vi.fn()}/>);
describe('Dialpad desktop call panel',()=>{
 it('requires explicit device selection and sends one exact grant snapshot with an idempotency key',async()=>{
  mount();const user=userEvent.setup();const select=await screen.findByLabelText('Dialpad desktop');
  expect(screen.getByRole('button',{name:'Call with Dialpad'})).toBeDisabled();expect(select).toHaveValue('');
  await user.selectOptions(select,'native');await user.dblClick(screen.getByRole('button',{name:'Call with Dialpad'}));
  expect(m.start).toHaveBeenCalledTimes(1);expect(m.start).toHaveBeenCalledWith({propertyId:'property',grantId:'grant',grantRevision:2,bindingRevision:3,connectionVersion:4,deviceId:'native',idempotencyKey:expect.stringMatching(/^[0-9a-f-]{36}$/)});
  expect(await screen.findByText(/Call status is not confirmed here/)).toBeVisible();expect(screen.queryByRole('button',{name:'Call with Dialpad'})).toBeNull();expect(screen.queryByRole('button',{name:'Mute'})).toBeNull();
 });
 it.each(['reject','throw'])('does not offer a fresh start after %s uncertainty',async kind=>{
  if(kind==='reject')m.start.mockResolvedValue({ok:false,error:'unconfirmed'});else m.start.mockRejectedValue(new Error('secret'));
  mount();const user=userEvent.setup();await user.selectOptions(await screen.findByLabelText('Dialpad desktop'),'native');await user.click(screen.getByRole('button',{name:'Call with Dialpad'}));
  expect(await screen.findByRole('alert')).not.toHaveTextContent('secret');expect(m.start).toHaveBeenCalledTimes(1);expect(screen.queryByRole('button',{name:'Back to dialer'})).toBeNull();
 });
 it('uses read-only status to release only after persisted completion',async()=>{
  m.status.mockResolvedValue({ok:true,intentId:'intent',status:'completed'});mount();const user=userEvent.setup();await user.selectOptions(await screen.findByLabelText('Dialpad desktop'),'native');await user.click(screen.getByRole('button',{name:'Call with Dialpad'}));
  expect(await screen.findByRole('button',{name:'Back to dialer'})).toBeVisible();expect(m.start).toHaveBeenCalledTimes(1);expect(m.status).toHaveBeenCalledWith({intentId:'intent'});
 });
 it('sanitizes device lookup failure and never starts',async()=>{
  m.devices.mockRejectedValue(new Error('secret'));mount();expect(await screen.findByRole('alert')).toHaveTextContent('Could not verify');expect(m.start).not.toHaveBeenCalled();
 });
 it('recovered active call has no setup or cancel window while status lookup is pending',()=>{
  m.status.mockReturnValue(new Promise(()=>{}));
  render(<DialpadDesktopPanel propertyId="property" leadName="Existing call" initialCall={{intentId:'intent',status:'linked'}} onCancel={vi.fn()}/>);
  expect(screen.queryByRole('button',{name:'Back'})).toBeNull();expect(screen.queryByLabelText('Dialpad desktop')).toBeNull();expect(m.devices).not.toHaveBeenCalled();expect(screen.getByText(/Call status is not confirmed here/)).toBeVisible();
 });
 it('cancelled persisted intent is terminal',()=>{
  render(<DialpadDesktopPanel propertyId="property" leadName="Existing call" initialCall={{intentId:'intent',status:'cancelled'}} onCancel={vi.fn()}/>);
  expect(screen.getByRole('button',{name:'Back to dialer'})).toBeVisible();expect(m.status).not.toHaveBeenCalled();
 });
 it('recovers lost start response by read-only lookup without redialing',async()=>{
  m.start.mockRejectedValue(new Error('lost response'));m.active.mockResolvedValue({ok:true,call:{intentId:'intent',propertyId:'property',status:'linked'}});
  mount();const user=userEvent.setup();await user.selectOptions(await screen.findByLabelText('Dialpad desktop'),'native');await user.click(screen.getByRole('button',{name:'Call with Dialpad'}));
  expect(await screen.findByText('Call reference: intent')).toBeVisible();expect(m.start).toHaveBeenCalledTimes(1);expect(m.active).toHaveBeenCalledTimes(1);
 });
 it('hangup request does not claim completion or release the call',async()=>{
  mount();const user=userEvent.setup();await user.selectOptions(await screen.findByLabelText('Dialpad desktop'),'native');await user.click(screen.getByRole('button',{name:'Call with Dialpad'}));
  await user.click(await screen.findByRole('button',{name:'Request hangup'}));
  expect(screen.getByRole('button',{name:'Hangup requested; waiting for confirmation'})).toBeDisabled();
  expect(screen.queryByRole('button',{name:'Back to dialer'})).toBeNull();expect(m.start).toHaveBeenCalledTimes(1);
 });
 it('does not auto-select a single registered device',async()=>{mount();await waitFor(()=>expect(screen.getByLabelText('Dialpad desktop')).toHaveValue(''));expect(m.start).not.toHaveBeenCalled();});
});
