"use client";

import { useParams } from "next/navigation";
import { Suspense } from "react";
import { GraphExplorer } from "@/components/graph/GraphExplorer";
import { RequireAuth, TopBar } from "@/components/shell";
import { TripNav } from "@/components/trip-nav";
import { Spinner } from "@/components/ui";
import { useFixtureMode } from "@/lib/graph";
import { useTrip } from "@/lib/queries";

function GraphPage({ tripId }: { tripId: string }) {
  const fixture = useFixtureMode();
  const trip = useTrip(tripId);
  const explorer = <GraphExplorer tripId={tripId} />;
  return (
    <>
      <TopBar>
        <TripNav tripId={tripId} tripName={trip.data?.trip.name} />
      </TopBar>
      {/* The dev fixture works without the API, so it skips sign-in. */}
      {fixture ? explorer : <RequireAuth>{explorer}</RequireAuth>}
    </>
  );
}

export default function Page() {
  const { tripId } = useParams<{ tripId: string }>();
  return (
    <Suspense fallback={<Spinner />}>
      <GraphPage tripId={tripId} />
    </Suspense>
  );
}
