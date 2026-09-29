import { Suspense } from "react";

import { DripMessagesPreview } from "../messages/preview";

export default function BrandCantStartPage() {
  return <Suspense fallback={null}><DripMessagesPreview cantStart /></Suspense>;
}
