"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect, useRef } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const reportedError = useRef<Error | null>(null);

  useEffect(() => {
    if (reportedError.current === error) return;
    reportedError.current = error;
    Sentry.captureException(error);
  }, [error]);

  return (
    <html>
      <body>
        <main style={{ display: "grid", minHeight: "100vh", placeItems: "center" }}>
          <div role="alert" style={{ textAlign: "center" }}>
            <h1>Something went wrong</h1>
            <p>Please try loading Sandra again.</p>
            <button type="button" onClick={reset}>
              Try again
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
