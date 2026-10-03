"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useMemo, useState } from "react";

import { OutcomeBar } from "@/components/leads/outcome-bar";

import { DripCard } from "./drip-card";
import type { OutcomeBarDrip } from "./lead-outcome-drip";

type LeadOutcomeContextValue = { refreshToken: number; refreshDrip: () => void };

const LeadOutcomeContext = createContext<LeadOutcomeContextValue>({
  refreshToken: 0,
  refreshDrip: () => {},
});

/** Shares one drip-refresh signal between the outcome bar and the drip card. */
export function LeadOutcomeProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [refreshToken, setRefreshToken] = useState(0);
  const refreshDrip = useCallback(() => {
    setRefreshToken((token) => token + 1);
    router.refresh();
  }, [router]);
  const value = useMemo(() => ({ refreshToken, refreshDrip }), [refreshToken, refreshDrip]);
  return <LeadOutcomeContext.Provider value={value}>{children}</LeadOutcomeContext.Provider>;
}

/** DripCard that refetches (remounts) whenever the outcome bar changes a drip. */
export function LeadDripCard({ propertyId }: { propertyId: string }) {
  const { refreshToken } = useContext(LeadOutcomeContext);
  return <DripCard key={refreshToken} propertyId={propertyId} />;
}

export function LeadOutcomeSection({
  propertyId,
  address,
  initialDispo,
  propertyStatus,
  currentUserId,
  drip,
  dripUnknown,
}: {
  propertyId: string;
  address: string | null;
  initialDispo: string | null;
  propertyStatus: string | null;
  currentUserId: string | null;
  drip: OutcomeBarDrip;
  dripUnknown: boolean;
}) {
  const router = useRouter();
  const { refreshDrip } = useContext(LeadOutcomeContext);
  return (
    <OutcomeBar
      propertyId={propertyId}
      propertyAddress={address}
      initialDispo={initialDispo}
      propertyStatus={propertyStatus}
      currentUserId={currentUserId}
      activeDripEnrollmentId={drip.activeDripEnrollmentId}
      activeDripSequenceId={drip.activeDripSequenceId}
      activeDripName={drip.activeDripName}
      activeDripStep={drip.activeDripStep}
      activeDripTotal={drip.activeDripTotal}
      showMoveToLead={false}
      showBookAppointment={false}
      syncFromProps
      dripPickersDisabled={dripUnknown}
      onDispositionChanged={() => router.refresh()}
      onDripChanged={refreshDrip}
    />
  );
}
