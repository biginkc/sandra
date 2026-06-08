"use client";

import { useEffect, useRef } from "react";

export function LoginBackground() {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    v.muted = true;
    v.defaultMuted = true;
    v.loop = true;
    v.volume = 0;
    v.play().catch(() => {});
  }, []);

  return (
    <div className="pointer-events-none fixed inset-0 -z-10" aria-hidden="true">
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(120% 90% at 50% 22%, #16203a 0%, #0c1426 34%, #070b16 64%, #05080f 100%), linear-gradient(160deg, #0a0f1f 0%, #060912 60%, #04060d 100%)",
        }}
      />
      <video
        ref={ref}
        autoPlay
        loop
        muted
        playsInline
        preload="auto"
        className="absolute inset-0 h-full w-full object-cover"
      >
        <source src="/brand/background.mp4" type="video/mp4" />
      </video>
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(120% 120% at 50% 50%, transparent 52%, rgba(0,0,0,0.55) 100%)",
        }}
      />
    </div>
  );
}
