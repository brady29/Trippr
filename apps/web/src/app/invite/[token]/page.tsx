"use client";

import type { InvitePreview } from "@trippr/contracts";
import { shortDate } from "@trippr/rules";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useParams, useRouter } from "next/navigation";
import { BoardHeader, RequireAuth } from "@/components/shell";
import { Button, ErrorNote, Spinner } from "@/components/ui";
import { api } from "@/lib/api";

function Accept({ token, preview }: { token: string; preview: InvitePreview }) {
  const router = useRouter();
  const accept = useMutation({
    mutationFn: () => api<{ tripId: string }>(`/invites/${token}/accept`, { method: "POST" }),
    onSuccess: ({ tripId }) => router.replace(`/trips/${tripId}`),
  });
  return (
    <div className="space-y-3">
      <Button variant="primary" onClick={() => accept.mutate()} disabled={accept.isPending || preview.expired}>
        Join as {preview.role}
      </Button>
      {accept.error ? <ErrorNote error={accept.error} /> : null}
    </div>
  );
}

export default function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const preview = useQuery({ queryKey: ["invite", token], queryFn: () => api<InvitePreview>(`/invites/${token}`) });
  return (
    <>
      <BoardHeader eyebrow="You're invited" title={preview.data?.trip.name ?? "Invite"} width="max-w-xl" />
      <main className="mx-auto max-w-xl space-y-4 px-4 py-6 sm:px-6">
        {preview.isPending ? <Spinner /> : null}
        {preview.error ? <ErrorNote error={preview.error} /> : null}
        {preview.data ? (
          <section className="ticket grid grid-cols-[minmax(0,1fr)_auto]" aria-label="Your invite">
            <div className="space-y-3 p-4 sm:p-5">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">Trip</div>
                <div className="text-lg font-semibold">{preview.data.trip.name}</div>
              </div>
              <p className="text-sm text-ink-soft">
                You&apos;ll join as <strong className="text-ink">{preview.data.role}</strong>
                {preview.data.role === "viewer" ? ": you can look, vote and comment" : ": you can change routes"}.
                {preview.data.expired ? " This link has expired; ask for a new one." : ""}
              </p>
            </div>
            <div className="flex flex-col items-center justify-center border-l-2 border-dashed border-line px-4 text-center">
              <div className="text-[10px] uppercase tracking-[0.16em] text-ink-faint">Departs</div>
              <div className="font-mono text-lg font-semibold">{shortDate(preview.data.trip.startDate)}</div>
            </div>
          </section>
        ) : null}
        {preview.data ? (
          <RequireAuth>
            <Accept token={token} preview={preview.data} />
          </RequireAuth>
        ) : null}
      </main>
    </>
  );
}
