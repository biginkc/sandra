import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
const {search,associate,refresh}=vi.hoisted(()=>({search:vi.fn(),associate:vi.fn(),refresh:vi.fn()}));
vi.mock("./actions",()=>({findCallbackLeads:search,associateCallback:associate}));
vi.mock("next/navigation",()=>({useRouter:()=>({refresh})}));
import {CallbackReview} from "./callback-review";
beforeEach(()=>{vi.clearAllMocks();search.mockResolvedValue({leads:[{id:"p1",address:"1 Main Street"}]});associate.mockResolvedValue({ok:true});});
afterEach(cleanup);
const mount=()=>render(<CallbackReview callId="call-1" updatedAt="2026-10-05T00:00:00Z"/>);
describe("inbound manual review",()=>{
  it("requires search, explicit property selection and confirmation",async()=>{
    mount();expect(search).not.toHaveBeenCalled();expect(associate).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Search lead address"),{target:{value:"Main"}});
    fireEvent.click(screen.getByRole("button",{name:"Search leads"}));
    const select=await screen.findByLabelText("Confirmed property");
    expect(screen.queryByRole("button",{name:"Associate confirmed property"})).toBeNull();
    fireEvent.change(select,{target:{value:"p1"}});
    fireEvent.click(screen.getByRole("button",{name:"Associate confirmed property"}));
    await waitFor(()=>expect(associate).toHaveBeenCalledWith("call-1","p1","2026-10-05T00:00:00Z"));
    await waitFor(()=>expect(refresh).toHaveBeenCalledOnce());
  });
  it("retains unresolved calls when the search has no result",async()=>{
    search.mockResolvedValue({leads:[]});mount();fireEvent.change(screen.getByLabelText("Search lead address"),{target:{value:"Unknown"}});fireEvent.click(screen.getByRole("button",{name:"Search leads"}));
    expect(await screen.findByRole("status")).toHaveTextContent("Leave this call for review");expect(associate).not.toHaveBeenCalled();
  });
  it("shows stale review errors instead of implying an association succeeded",async()=>{
    associate.mockResolvedValue({error:"This call changed. Reload before reviewing it."});mount();fireEvent.change(screen.getByLabelText("Search lead address"),{target:{value:"Main"}});fireEvent.click(screen.getByRole("button",{name:"Search leads"}));fireEvent.change(await screen.findByLabelText("Confirmed property"),{target:{value:"p1"}});fireEvent.click(screen.getByRole("button",{name:"Associate confirmed property"}));
    expect(await screen.findByRole("status")).toHaveTextContent("This call changed");expect(refresh).not.toHaveBeenCalled();
  });
});
