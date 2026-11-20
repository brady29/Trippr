"use client";

import type { CalendarFeedLink } from "@trippr/contracts";
import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { useCalendarFeed, useCreateCalendarFeed, useDeleteCalendarFeed } from "@/lib/calendar";
import { CalendarIcon } from "./icons";
import { useToast } from "./toast";
import { Button, ErrorNote, Spinner } from "./ui";

/**
 * "Add to calendar": a private link to the trip's current route that calendar
 * apps subscribe to. The link is only shown right after it's made, since the
 * API keeps just a hash of it.
 */
export function CalendarFeedPanel({ tripId, onClose }: { tripId: string; onClose?: () => void }) {
  const { me } = useAuth();
  const demo = me?.isDemo === true;
  const toast = useToast();
  const status = useCalendarFeed(tripId, !demo);
  const create = useCreateCalendarFeed(tripId);
  const remove = useDeleteCalendarFeed(tripId);
  const [link, setLink] = useState<CalendarFeedLink | null>(null);
  const [includePrivate, setIncludePrivate] = useState<boolean | null>(null);

  const canIncludePrivate = status.data?.canIncludePrivate === true;
  const enabled = status.data?.enabled === true;
  const wantPrivate = canIncludePrivate && (includePrivate ?? status.data?.includePrivate ?? false);
  const busy = create.isPending || remove.isPending;

  const make = (again: boolean) => {
    if (again && !window.confirm("Make a new link? The current one will stop working in every calendar that uses it.")) return;
    create.mutate(
      { includePrivate: wantPrivate },
      {
        onSuccess: (made) => {
          setLink(made);
          setIncludePrivate(null);
          if (again) toast("New link made. The old one no longer works.", "ok");
        },
        onError: (e) => toast(e instanceof Error ? e.message : "Couldn't make the link", "error"),
      },
    );
  };
  const turnOff = () => {
    if (!window.confirm("Turn off your calendar link? Calendars subscribed to it will stop updating.")) return;
    remove.mutate(undefined, {
      onSuccess: () => {
        setLink(null);
        toast("Calendar link turned off", "ok");
      },
      onError: (e) => toast(e instanceof Error ? e.message : "Couldn't turn it off", "error"),
    });
  };
  const copy = (text: string) =>
    void navigator.clipboard?.writeText(text).then(
      () => toast("Link copied", "ok"),
      () => toast("Couldn't copy; select the link and copy it", "error"),
    );

  return (
    <section className="rounded-2xl border border-line bg-card p-4 text-sm" data-testid="calendar-panel" aria-label="Add to calendar">
      <div className="mb-2 flex items-center gap-2">
        <CalendarIcon className="h-4 w-4 text-ink-soft" />
        <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-soft">Add to calendar</h2>
        {onClose ? (
          <button className="ml-auto text-xs text-ink-soft hover:underline" onClick={onClose}>
            Close
          </button>
        ) : null}
      </div>

      {demo ? (
        <div className="space-y-2" data-testid="calendar-demo">
          <p className="text-ink-soft">
            Subscribe to the trip&apos;s current route in Google Calendar, Apple Calendar or Outlook, and it stays up to date as the plan changes.
          </p>
          <p className="text-xs text-ink-faint">The demo is read-only, so it can&apos;t make calendar links. Sign in to subscribe to your own trip.</p>
          <Button disabled>Make my calendar link</Button>
        </div>
      ) : status.isPending ? (
        <Spinner />
      ) : status.error ? (
        <ErrorNote error={status.error} />
      ) : (
        <div className="space-y-3">
          <p className="text-ink-soft">
            Your private link to this trip&apos;s current route. Calendars that subscribe to it update as the plan changes. Anyone with the link can see
            the plan, so keep it to yourself.
          </p>

          {canIncludePrivate ? (
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={wantPrivate}
                onChange={(e) => setIncludePrivate(e.target.checked)}
                disabled={busy}
              />
              <span>
                Include booking references
                <span className="block text-xs text-ink-faint">Calendar providers store feed contents on their own servers.</span>
                {enabled && wantPrivate !== status.data?.includePrivate ? (
                  <span className="block text-xs text-amber">Applies to the next link you make.</span>
                ) : null}
              </span>
            </label>
          ) : null}

          {link ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded bg-paper-2 px-2 py-1 font-mono text-xs select-all" data-testid="calendar-link">
                  {link.webcalUrl}
                </code>
                <Button size="sm" onClick={() => copy(link.webcalUrl)}>
                  Copy
                </Button>
              </div>
              <div className="flex flex-wrap gap-2">
                <a
                  className="inline-flex h-8 items-center rounded-lg border border-line bg-card px-2.5 text-xs font-medium hover:border-ink-faint"
                  href={link.googleUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Google Calendar
                </a>
                <a
                  className="inline-flex h-8 items-center rounded-lg border border-line bg-card px-2.5 text-xs font-medium hover:border-ink-faint"
                  href={link.webcalUrl}
                >
                  Apple Calendar
                </a>
              </div>
              <p className="text-xs text-ink-faint">
                This link is shown only now. Copy it somewhere safe, or make a new one later.
                {link.includePrivate ? " It includes booking references." : ""}
              </p>
            </div>
          ) : enabled ? (
            <p className="text-xs text-ink-soft" data-testid="calendar-on">
              Your calendar link is on{status.data?.includePrivate ? " and includes booking references" : ""}. For your safety it can&apos;t be shown
              again; make a new link to copy it (the old one stops working).
            </p>
          ) : (
            <Button variant="primary" onClick={() => make(false)} disabled={busy}>
              {create.isPending ? "Making the link…" : "Make my calendar link"}
            </Button>
          )}

          {enabled || link ? (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => make(true)} disabled={busy}>
                Make a new link
              </Button>
              <Button size="sm" variant="danger" onClick={turnOff} disabled={busy}>
                Turn off
              </Button>
            </div>
          ) : null}

          <p className="text-xs text-ink-faint">
            Google Calendar refreshes subscriptions on its own schedule, which can take up to a day. Apple Calendar and Outlook update more often.
          </p>
        </div>
      )}
    </section>
  );
}
