import { createRoot } from "react-dom/client";
import {
  SoftphoneHeaderButton,
  SoftphoneProvider,
  useSoftphone,
} from "@/components/softphone/softphone-provider";
import type { CallTransport, CallTransportState } from "@/lib/dialer/transport";
import { precallProfiles } from "./precall-profiles";
import {
  chooseProfile,
  matrixEvidence,
  matrixFaults,
} from "./precall-matrix-boundary";
let calls = 0;
const transportFactory = (): CallTransport => {
  let listener: (state: CallTransportState) => void = () => undefined;
  return {
    onStateChange: (cb) => {
      listener = cb;
    },
    start: async () => {
      calls++;
      listener("live");
      return { id: `synthetic-${calls}` };
    },
    hangup: async () => ({ durationSeconds: 1, outcome: "connected_human" }),
    mute: async () => true,
    hold: async () => true,
    reconnectAudio: async () => true,
    sendDigit: async () => true,
  };
};
function Targets() {
  const phone = useSoftphone();
  return (
    <>
      <SoftphoneHeaderButton />
      {precallProfiles.map((p, index) => (
        <button
          key={index}
          data-testid={`profile-${index}`}
          onClick={() => {
            chooseProfile(index);
            if (!p.target.propertyId) {
              phone.toggleOpen();
              return;
            }
            phone.openLead({
              id: p.target.propertyId ?? "",
              contactId: null,
              firstName: p.target.name,
              name: p.target.name,
              address: p.target.address ?? "",
              state: "MO",
              phones: [p.target.phoneE164],
              dncLocked: false,
              contactDnc: false,
              callable: true,
            });
          }}
        >
          {p.label}
        </button>
      ))}
    </>
  );
}
Object.assign(window, {
  precallMatrixEvidence: matrixEvidence,
  precallMatrixFaults: matrixFaults,
});
createRoot(document.getElementById("root")!).render(
  <SoftphoneProvider transportFactory={transportFactory}>
    <Targets />
  </SoftphoneProvider>,
);
