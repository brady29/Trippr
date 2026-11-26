"use client";

import { useParams } from "next/navigation";
import { Suspense } from "react";
import { GraphExplorer } from "@/components/graph/GraphExplorer";
import { RequireAuth } from "@/components/shell";
import { Spinner } from "@/components/ui";
import { useFixtureMode } from "@/lib/graph";

function GraphPage({ tripId }: { tripId: string }) {
  const fixture = useFixtureMode();
  const explorer = <GraphExplorer tripId={tripId} />;
  // The dev fixture works without the API, so it skips sign-in.
  return fixture ? explorer : <RequireAuth>{explorer}</RequireAuth>;
}

export default function Page() {
  const { tripId } = useParams<{ tripId: string }>();
  return (
    <Suspense fallback={<Spinner />}>
      <GraphPage tripId={tripId} />
    </Suspense>
  );
}
