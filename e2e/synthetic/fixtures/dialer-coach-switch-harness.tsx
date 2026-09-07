import { createRoot } from "react-dom/client";
import { SoftphoneHeaderButton, SoftphoneProvider } from "@/components/softphone/softphone-provider";

createRoot(document.getElementById("root")!).render(
  <SoftphoneProvider><SoftphoneHeaderButton /></SoftphoneProvider>,
);
