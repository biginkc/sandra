import { createRoot } from "react-dom/client";
import { AfterAttemptDripPicker } from "../../../src/components/sequences/after-attempt-drip-picker";
createRoot(document.getElementById("root")!).render(<div style={{height:340,overflow:"auto",border:"1px solid",padding:12}}>
  <p>Attempt saved.</p><AfterAttemptDripPicker propertyId="synthetic" onEnrolled={() => { document.body.dataset.enrolled = "true"; }} />
</div>);
