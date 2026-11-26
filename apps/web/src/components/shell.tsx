"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useAuth } from "@/lib/auth";
import { ClerkSignIn } from "@/lib/clerk";
import { Button, Input, Spinner } from "./ui";

/** Split-flap text: one tile per character, for the departure-board look. */
export function Flaps({ text, className = "" }: { text: string; className?: string }) {
  return (
    <span className={`inline-flex flex-wrap ${className}`} aria-label={text}>
      {[...text.toUpperCase()].map((ch, i) => (
        <span key={i} className="flap" aria-hidden>
          {ch === " " ? " " : ch}
        </span>
      ))}
    </span>
  );
}

/**
 * Departure-board header at the top of each screen. Compact: one row for the
 * split-flap title and its actions, one for the stats.
 */
export function BoardHeader({
  eyebrow,
  title,
  badges,
  meta,
  actions,
  below,
}: {
  eyebrow: string;
  title: string;
  /** Small tags beside the title, e.g. "current". */
  badges?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  /** A full-width strip under the header, e.g. the route timeline. */
  below?: ReactNode;
}) {
  return (
    <div className="bg-board text-amber-soft">
      <div className="mx-auto max-w-6xl px-4 py-3 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
          <div className="min-w-0">
            <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-amber-soft/60">{eyebrow}</div>
            <div className="mt-1.5 flex flex-wrap items-center gap-2.5">
              <h1 className="text-xl sm:text-2xl">
                <Flaps text={title} />
              </h1>
              {badges}
            </div>
          </div>
          {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
        </div>
        {meta ? <div className="mt-2.5 flex flex-wrap items-center gap-x-5 gap-y-1.5 font-mono text-xs">{meta}</div> : null}
      </div>
      {below}
    </div>
  );
}

export function BoardStat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-[10px] uppercase tracking-[0.18em] text-amber-soft/55">{label}</span>
      <span className="text-amber">{value}</span>
    </div>
  );
}

function SignInPanel() {
  const { config, clerkEnabled, signInDev, signInDemo } = useAuth();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto mt-10 max-w-md px-4">
      <div className="ticket overflow-hidden">
        <div className="bg-board px-6 py-5">
          <div className="font-mono text-[11px] uppercase tracking-[0.25em] text-amber-soft/60">Boarding pass</div>
          <div className="mt-2 text-2xl">
            <Flaps text="Trippr" />
          </div>
          <p className="mt-3 text-sm text-amber-soft/80">
            One shared plan for the whole group: tagged routes, a shared activity library, and checks for visa days and fixed-date events.
          </p>
        </div>
        <div className="space-y-4 px-6 py-5">
          {clerkEnabled ? (
            <ClerkSignIn>
              <Button variant="primary" className="w-full">
                Sign in
              </Button>
            </ClerkSignIn>
          ) : null}
          {config?.devLogin ? (
            <form
              className="space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (name.trim()) void run(() => signInDev(name.trim()));
              }}
            >
              <label htmlFor="dev-name" className="block text-xs font-medium uppercase tracking-wide text-ink-soft">
                Your name (local sign-in)
              </label>
              <div className="flex gap-2">
                <Input id="dev-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Brady" autoComplete="name" />
                <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
                  Sign in
                </Button>
              </div>
            </form>
          ) : null}
          {config?.demo ? (
            <Button className="w-full" disabled={busy} onClick={() => void run(signInDemo)}>
              Look around the demo (read-only)
            </Button>
          ) : null}
          {config && !config.devLogin && !config.demo && !clerkEnabled ? (
            <p className="text-sm text-ink-soft">Sign-in is not configured on this deployment.</p>
          ) : null}
          {!config ? <Spinner label="Connecting to the API" /> : null}
          {error ? <p className="text-sm text-err">{error}</p> : null}
        </div>
      </div>
    </div>
  );
}

/** Renders children only when signed in; otherwise the sign-in panel. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted || status === "loading") {
    return (
      <div className="mx-auto max-w-6xl px-4 py-10">
        <Spinner />
      </div>
    );
  }
  if (status === "signedOut") return <SignInPanel />;
  return <>{children}</>;
}
