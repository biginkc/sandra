import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { RecordingLibrary } from './library';
const mocks=vi.hoisted(()=>({push:vi.fn(),fetch:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({push:mocks.push})}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({auth:{onAuthStateChange:()=>({data:{subscription:{unsubscribe:vi.fn()}}})}})}));
const result={viewerId:'viewer',nextCursor:null,total:1,availability:{available:1},sources:['jitter'],outcomes:['connected'],users:[{id:'person',name:'Acquisition person'}],rows:[{id:'call:one',at:'2026-09-14T12:00:00Z',actor_id:'person',actor_name:'Acquisition person',conflicting:false,source:'jitter',outcome:'connected',direction:'outbound',purpose:'customer',contact:'Fixture contact',address:'Fixture property',phone:null,property_id:null,missing_association:false,transcript:false,summary:false,status:'available',files:[{id:'file1',duration:30,status:'available',kind:'stored'}]}]};
beforeEach(()=>{vi.clearAllMocks();vi.stubGlobal('fetch',mocks.fetch);vi.spyOn(HTMLMediaElement.prototype,'play').mockResolvedValue();});
it('shows employee and group selectors only for the owner library',()=>{
 const {unmount}=render(<RecordingLibrary result={result} scope="owner" values={{}}/>);
 expect(screen.getByLabelText(/Users \(select/)).toBeInTheDocument();expect(screen.getByRole('option',{name:'Everyone currently active in acquisitions'})).toBeInTheDocument();unmount();
 render(<RecordingLibrary result={{...result,users:[]}} scope="mine" values={{}}/>);
 expect(screen.queryByLabelText(/Users \(select/)).not.toBeInTheDocument();expect(screen.queryByLabelText('Group')).not.toBeInTheDocument();
});
it('preserves filter URL values and resets the page cursor on submit',()=>{
 render(<RecordingLibrary result={result} scope="owner" values={{q:'First',cursor:'old'}}/>);
 fireEvent.change(screen.getByLabelText('Contact, property address or phone'),{target:{value:'Second'}});
 fireEvent.click(screen.getByRole('button',{name:'Apply filters'}));
 expect(mocks.push).toHaveBeenCalledWith(expect.stringContaining('q=Second'));expect(mocks.push.mock.calls[0]?.[0]).not.toContain('cursor');
});
it('preserves listening position and speed when a signed link is refreshed',async()=>{
 mocks.fetch.mockResolvedValueOnce({ok:true,json:async()=>({signedUrl:'https://audio.test/first'})}).mockResolvedValueOnce({ok:true,json:async()=>({signedUrl:'https://audio.test/renewed'})});
 const {container}=render(<RecordingLibrary result={result} scope="mine" values={{}}/>);
 fireEvent.click(screen.getByText('1 recording file'));fireEvent.click(screen.getByRole('button',{name:'Play recording'}));
 await waitFor(()=>expect(container.querySelector('audio')).not.toBeNull());
 const first=container.querySelector('audio')!;first.currentTime=12;first.playbackRate=1.5;
 fireEvent.click(screen.getByRole('button',{name:'Refresh playback link'}));
 await waitFor(()=>expect(container.querySelector('audio')?.src).toBe('https://audio.test/renewed'));
 const renewed=container.querySelector('audio')!;fireEvent.loadedMetadata(renewed);
 expect(renewed.currentTime).toBe(12);expect(renewed.playbackRate).toBe(1.5);
});
