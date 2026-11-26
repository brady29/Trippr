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
      <BoardHeader eyebrow="You're invited" title={preview.data?.trip.name ?? "Invite"} />
      <main className="mx-auto max-w-xl space-y-4 px-4 py-6">
        {preview.isPending ? <Spinner /> : null}
        {preview.error ? <ErrorNote error={preview.error} /> : null}
        {preview.data ? (
          <>
            <p className="text-sm text-ink-soft">
              {preview.data.trip.name} starts {shortDate(preview.data.trip.startDate)}. You&apos;ll join as{" "}
              <strong>{preview.data.role}</strong>
              {preview.data.role === "viewer" ? " (you can look, vote and comment)" : ""}.
              {preview.data.expired ? " This link has expired; ask for a new one." : ""}
            </p>
            <RequireAuth>
              <Accept token={token} preview={preview.data} />
            </RequireAuth>
          </>
        ) : null}
      </main>
    </>
  );
}
