"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { useAuth } from "@/lib/auth";
import { ClerkSignIn } from "@/lib/clerk";
import { Button, Input, Spinner, Tag } from "./ui";

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

export function TopBar({ children }: { children?: ReactNode }) {
  const { me, status, signOut } = useAuth();
  return (
    <header className="bg-board text-amber-soft">
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-2.5">
        <Link href="/" className="flex items-center gap-2 font-mono text-sm font-semibold tracking-[0.2em] text-amber">
          <span className="grid h-6 w-6 place-items-center rounded bg-amber text-board">T</span>
          TRIPPR
        </Link>
        <nav className="ml-2 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto text-sm">{children}</nav>
        {status === "signedIn" && me ? (
          <div className="flex items-center gap-2">
            {me.isDemo ? <Tag tone="board">demo, read-only</Tag> : null}
            <span className="hidden max-w-[10rem] truncate text-xs text-amber-soft/80 sm:inline">{me.name}</span>
            <button onClick={() => void signOut()} className="text-xs text-amber-soft/70 underline-offset-2 hover:underline">
              Sign out
            </button>
          </div>
        ) : null}
      </div>
    </header>
  );
}

export function NavLink({ href, children, active }: { href: string; children: ReactNode; active?: boolean }) {
  return (
    <Link
      href={href}
      className={`whitespace-nowrap rounded-md px-2.5 py-1 ${active ? "bg-board-3 text-amber" : "text-amber-soft/80 hover:text-amber"}`}
    >
      {children}
    </Link>
  );
}

/** Departure-board header used on the trip and route screens. */
export function BoardHeader({
  eyebrow,
  title,
  meta,
  actions,
}: {
  eyebrow: string;
  title: string;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="bg-board pb-5 pt-4 text-amber-soft">
      <div className="mx-auto max-w-6xl px-4">
        <div className="font-mono text-[11px] uppercase tracking-[0.25em] text-amber-soft/60">{eyebrow}</div>
        <h1 className="mt-2 text-2xl sm:text-3xl">
          <Flaps text={title} />
        </h1>
        {meta ? <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 font-mono text-xs">{meta}</div> : null}
        {actions ? <div className="mt-4 flex flex-wrap gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}

export function BoardStat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.2em] text-amber-soft/50">{label}</div>
      <div className="text-sm text-amber">{value}</div>
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
