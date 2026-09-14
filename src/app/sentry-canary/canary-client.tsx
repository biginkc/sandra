"use client";

import { useState } from "react";

export default function CanaryClient() {
  const [fail, setFail] = useState(false);
  if (fail) throw new Error("Controlled Sentry preview client render failure");
  return <button type="button" onClick={() => setFail(true)}>Trigger client error</button>;
}
