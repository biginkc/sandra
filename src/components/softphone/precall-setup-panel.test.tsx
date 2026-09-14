import {useState} from 'react';
import {render,screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {describe,expect,it,vi} from 'vitest';
import {PrecallSetupPanel} from './precall-setup-panel';
import type {SetupDraft} from '@/lib/coach/precall-setup';
import type {CoachCallContext} from '@/lib/coach/types';
const context:CoachCallContext={sellerName:'Casey Seller',propertyAddress:'1 Fictional Lane',propertyCounty:null,repName:'Alex Rep',authenticatedRepName:'Alex Rep',repPhoneE164:'+18165550100',motivation:null,leadId:'lead-ABC123',sellerPhoneE164:'+18165550101',coldCallerName:null,yearBuilt:'1962',leadSource:'cold_call',occupancy:'owner_occupied'};
function Panel({leadContext=context,retry=()=>undefined,targetKey='lead:A'}:{leadContext?:CoachCallContext;retry?:()=>void;targetKey?:string}){
 const [draft,setDraft]=useState<SetupDraft>({version:1,edits:{},branches:{Opener:'d4d'}}),[collapsed,setCollapsed]=useState(false);
 return <PrecallSetupPanel targetKey={targetKey} context={leadContext} draft={draft} collapsed={collapsed} onCollapsed={setCollapsed} loading={false} error={null} onRetry={retry} onField={(key,value)=>setDraft(d=>({...d,edits:{...d.edits,[key]:value}}))} onBranch={(key,value)=>setDraft(d=>({...d,branches:{...d.branches,[key]:value}}))}/>;
}
describe('precall panel interaction contract',()=>{
 it('keeps exactly one group open and only advances after explicit completion',async()=>{
  const user=userEvent.setup();render(<Panel/>);
  const basics=screen.getByRole('button',{name:/^Call basics/}),situation=screen.getByRole('button',{name:/^Seller’s situation/});
  expect(situation).toHaveAttribute('aria-expanded','true');
  await user.click(basics);expect(situation).toHaveAttribute('aria-expanded','false');
  const name=screen.getByTestId('setup-field-seller_name');await user.click(name);await user.type(name,' Jr');expect(name).toHaveFocus();
  await user.click(screen.getByText('FILE NUMBER · AUTO'));expect(basics).toHaveAttribute('aria-expanded','true');
  await user.click(screen.getByRole('button',{name:'Continue to seller’s situation'}));
  expect(basics).toHaveAttribute('aria-expanded','false');expect(situation).toHaveFocus();
  expect(situation).toHaveAttribute('aria-expanded','true');
 });
 it('shows a friendly opener and identifies remaining details in the compact receipt',async()=>{
  const user=userEvent.setup();render(<Panel/>);await user.click(screen.getByRole('button',{name:'Collapse'}));
  expect(screen.getByText(/Driving for dollars/)).toBeVisible();expect(screen.getByText(/Still needed:/)).toHaveTextContent('Reason for selling, Desired outcome');
  expect(screen.queryByText('Call details ready')).not.toBeInTheDocument();
 });
 it('keeps file number read-only and retries an unavailable value',async()=>{
  const retry=vi.fn(),user=userEvent.setup();render(<Panel leadContext={{...context,leadId:null}} retry={retry}/>);
  expect(screen.getByTestId('setup-file-number').tagName).toBe('OUTPUT');
  expect(screen.getByTestId('setup-file-number')).toHaveTextContent('Not available yet');
  await user.click(screen.getByRole('button',{name:'Retry'}));expect(retry).toHaveBeenCalledOnce();
  expect(screen.queryByRole('textbox',{name:/file number/i})).not.toBeInTheDocument();
 });
 it('does not count an unavailable file number for an unmatched target',async()=>{
  const user=userEvent.setup();render(<Panel targetKey="phone:+18165550101" leadContext={{...context,leadId:null}}/>);
  await user.click(screen.getByRole('button',{name:'Collapse'}));
  expect(screen.getByText(/Still needed:/)).not.toHaveTextContent('File number');
 });
 it('offers only the four approved opener choices',async()=>{
  const user=userEvent.setup();render(<Panel/>);await user.click(screen.getByRole('button',{name:/^Script branches/}));
  await user.click(screen.getByRole('combobox',{name:'Opener'}));
  expect((await screen.findAllByRole('option')).map(e=>e.textContent)).toEqual(['Cold call','FSBO','SMS reply','Driving for dollars']);
  expect(screen.queryByText(/All openers/i)).not.toBeInTheDocument();
 });
});
