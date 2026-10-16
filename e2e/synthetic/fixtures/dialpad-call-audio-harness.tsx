import { createRoot } from "react-dom/client"

import { MyLeadCallArtifacts } from "../../../src/app/(dashboard)/my-leads/_components/call-artifacts"

// A Dialpad attempt's recording block, exactly as the lead detail mounts it (`recordingOnly`).
createRoot(document.getElementById("root")!).render(
  <main className="mx-auto max-w-[640px] p-4 font-sans">
    <h1 className="mb-4 text-xl font-bold">Dialpad call recording</h1>
    <MyLeadCallArtifacts callActivityId="call-dialpad-1" recordingOnly />
  </main>,
)
