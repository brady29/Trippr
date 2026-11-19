"use client";

import type { BookingLink } from "@trippr/rules";

function ExternalIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </svg>
  );
}

/** "Book on Trip.com · Google Flights": search links filled in with the stop's cities, dates and group size. */
export function BookingLinks({ links, label = "Book on", className = "" }: { links: BookingLink[]; label?: string; className?: string }) {
  if (!links.length) return null;
  const hints = links.map((l) => l.hint).filter(Boolean);
  return (
    <div className={`text-[11px] ${className}`} data-testid="booking-links">
      <span className="text-ink-faint">{label} </span>
      {links.map((l, i) => (
        <span key={l.provider}>
          {i > 0 ? <span className="text-ink-faint"> · </span> : null}
          <a
            href={l.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 font-medium text-sky hover:underline"
            data-provider={l.provider}
          >
            {l.label}
            <ExternalIcon />
          </a>
        </span>
      ))}
      {hints.length ? <span className="block text-ink-faint">{hints.join(" ")}</span> : null}
    </div>
  );
}
