import { Suspense } from "react";

import { DripMessagesPreview } from "./preview";

export default function BrandMessagesPage() {
  return <Suspense fallback={null}><DripMessagesPreview /></Suspense>;
}
