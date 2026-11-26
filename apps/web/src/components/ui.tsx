"use client";

import type { CheckLevel } from "@trippr/rules";
import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import { AlertIcon, CheckIcon, InfoIcon } from "./icons";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** `board` is for buttons that sit on the dark departure board. */
  variant?: "primary" | "secondary" | "ghost" | "danger" | "board";
  size?: "sm" | "md";
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", className = "", type = "button", ...props },
  ref,
) {
  const variants = {
    primary: "bg-accent text-on-accent hover:bg-accent-hover border border-accent hover:border-accent-hover",
    secondary: "bg-card text-ink border border-line hover:border-ink-faint",
    ghost: "text-ink-soft hover:text-ink hover:bg-paper-2 border border-transparent",
    danger: "bg-card text-err border border-line hover:border-err",
    board: "bg-board-2 text-amber-soft border border-board-3 hover:text-amber hover:border-amber-soft/40",
  };
  const sizes = { sm: "h-8 px-2.5 text-xs gap-1.5", md: "h-10 px-3.5 text-sm gap-2" };
  return (
    <button
      ref={ref}
      type={type}
      className={`inline-flex shrink-0 items-center justify-center rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${variants[variant]} ${sizes[size]} ${className}`}
      {...props}
    />
  );
});

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className = "", ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={`h-10 w-full min-w-0 rounded-lg border border-line bg-card px-3 text-sm text-ink placeholder:text-ink-faint focus:border-ink-soft focus:outline-none ${className}`}
      {...props}
    />
  );
});

export function Select({ className = "", ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`h-10 min-w-0 rounded-lg border border-line bg-card px-2.5 text-sm text-ink focus:border-ink-soft focus:outline-none ${className}`}
      {...props}
    />
  );
}

export function Label({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-soft">
      {children}
    </label>
  );
}

export function Tag({ children, tone = "plain" }: { children: ReactNode; tone?: "plain" | "amber" | "dark" | "board" }) {
  const tones = {
    plain: "bg-paper-2 text-ink-soft",
    amber: "bg-mark/25 text-ink",
    dark: "bg-board text-amber",
    /** For use on the dark departure board. */
    board: "border border-amber/40 text-amber",
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

const LEVEL_STYLE: Record<CheckLevel, { cls: string; label: string }> = {
  ok: { cls: "text-ok bg-ok/10", label: "All checks pass" },
  info: { cls: "text-info bg-info/10", label: "Info" },
  warn: { cls: "text-warn bg-warn/10", label: "Needs a look" },
  error: { cls: "text-err bg-err/10", label: "Problem" },
};

export function LevelIcon({ level, className = "" }: { level: CheckLevel; className?: string }) {
  const Icon = level === "ok" ? CheckIcon : level === "info" ? InfoIcon : AlertIcon;
  return <Icon className={`${LEVEL_STYLE[level].cls.split(" ")[0]} ${className}`} />;
}

export function ChecksBadge({ level }: { level: CheckLevel }) {
  const style = LEVEL_STYLE[level];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${style.cls}`}>
      <LevelIcon level={level} className="h-3.5 w-3.5" />
      {style.label}
    </span>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <div role="status" className="flex items-center gap-2 text-sm text-ink-soft">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-line border-t-ink-soft" />
      {label}
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  return (
    <div role="alert" className="rounded-lg border border-err/30 bg-err/5 px-4 py-3 text-sm text-err">
      {error instanceof Error ? error.message : "Something went wrong"}
    </div>
  );
}

export interface MenuAction {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

/** A "⋯" button (or a labelled one) that opens a short list of actions under it. */
export function ActionMenu({
  label,
  actions,
  text,
  onBoard = false,
}: {
  label: string;
  actions: MenuAction[];
  /** Show a labelled button instead of "⋯". */
  text?: string;
  /** The button sits on the dark departure board. */
  onBoard?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  if (actions.length === 0) return null;
  return (
    <div ref={wrap} className="relative">
      {text ? (
        <Button size="sm" variant={onBoard ? "board" : "secondary"} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {text}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
            <path d="m6 9 6 6 6-6" />
          </svg>
        </Button>
      ) : (
        <button
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="grid h-8 w-8 place-items-center rounded-lg text-ink-soft hover:bg-paper-2 hover:text-ink"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <circle cx="5" cy="12" r="1.8" />
            <circle cx="12" cy="12" r="1.8" />
            <circle cx="19" cy="12" r="1.8" />
          </svg>
        </button>
      )}
      {open ? (
        <div role="menu" aria-label={label} className="absolute right-0 top-full z-30 mt-1 w-48 rounded-xl border border-line bg-card p-1 shadow-xl">
          {actions.map((a) => (
            <button
              key={a.label}
              role="menuitem"
              disabled={a.disabled}
              onClick={() => {
                setOpen(false);
                a.onSelect();
              }}
              className={`block w-full rounded-lg px-3 py-2 text-left text-sm disabled:opacity-50 ${a.danger ? "text-err hover:bg-err/10" : "hover:bg-paper-2"}`}
            >
              {a.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function Panel({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-card p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-soft">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}
