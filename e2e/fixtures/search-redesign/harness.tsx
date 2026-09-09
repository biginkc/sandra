import React from "react";
import { createRoot } from "react-dom/client";
import { Dialog } from "@base-ui/react/dialog";
import { GlobalSearchProvider } from "../../../src/components/search/global-search-provider";
import { GlobalSearchTrigger } from "../../../src/components/search/global-search-trigger";
import { SoftphoneProvider, SoftphoneHeaderButton } from "../../../src/components/softphone/softphone-provider";
import { SoftphoneLeadButton } from "../../../src/components/softphone/softphone-lead-button";
const lead = { id: "fixture", contactId: "fixture", firstName: "Fixture", name: "Fixture caller", address: "1 Fixture Street", state: "MO", phones: ["+18165550123"], dncLocked: false, contactDnc: false, callable: true };
function Harness() {
  return <SoftphoneProvider><GlobalSearchProvider>
    <header style={{ background: "#16233f", display: "flex", alignItems: "center", gap: 14, padding: 20 }}><GlobalSearchTrigger /><SoftphoneHeaderButton /></header>
    <main style={{ minHeight: 1800, padding: 20 }}><SoftphoneLeadButton lead={lead} />
      <Dialog.Root><Dialog.Trigger>Open outer dialog</Dialog.Trigger><Dialog.Portal><Dialog.Backdrop style={{ position: "fixed", inset: 0, zIndex: 70 }} /><Dialog.Popup style={{ position: "fixed", inset: 50, zIndex: 80, background: "white" }}><Dialog.Title>Outer dialog</Dialog.Title><p>Search can open above this modal without releasing its scroll lock.</p><Dialog.Close>Close outer dialog</Dialog.Close></Dialog.Popup></Dialog.Portal></Dialog.Root>
    </main>
  </GlobalSearchProvider></SoftphoneProvider>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
