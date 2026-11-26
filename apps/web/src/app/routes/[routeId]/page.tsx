"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";
import { RequireAuth } from "@/components/shell";
import { ErrorNote, Spinner } from "@/components/ui";
import { useRoute } from "@/lib/queries";
import { routeHref } from "@/lib/routes";

/** Old links pointed at /routes/:id; the editor now lives inside its trip. */
function Redirect({ routeId }: { routeId: string }) {
  const router = useRouter();
  const route = useRoute(routeId);
  const tripId = route.data?.trip.id;
  useEffect(() => {
    if (!tripId) return;
    const hash = window.location.hash.replace(/^#/, "");
    router.replace(routeHref(tripId, routeId, hash || undefined));
  }, [tripId, routeId, router]);
  return (
    <div className="mx-auto max-w-6xl px-4 py-8">{route.error ? <ErrorNote error={route.error} /> : <Spinner label="Opening the route" />}</div>
  );
}

export default function OldRoutePage() {
  const { routeId } = useParams<{ routeId: string }>();
  return (
    <RequireAuth>
      <Redirect routeId={routeId} />
    </RequireAuth>
  );
}
