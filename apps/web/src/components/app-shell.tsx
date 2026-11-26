"use client";

import type { RouteSummary } from "@trippr/contracts";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ComponentType, type ReactNode, type SVGProps } from "react";
import { useAuth } from "@/lib/auth";
import { useTripLive } from "@/lib/live";
import { useTrip, useTrips } from "@/lib/queries";
import { routeHref, tripContext, tripTile } from "@/lib/routes";
import { applyTheme, readTheme, type ThemeChoice } from "@/lib/theme";
import {
  CalendarIcon,
  ChatIcon,
  CheckIcon,
  CompareIcon,
  DatabaseIcon,
  DownIcon,
  GraphIcon,
  HomeIcon,
  InboxIcon,
  LogOutIcon,
  MapIcon,
  MonitorIcon,
  MoonIcon,
  PanelIcon,
  RouteIcon,
  SignpostIcon,
  StarIcon,
  SuitcaseIcon,
  SunIcon,
  TicketIcon,
} from "./icons";

// The Ask panel (and its streaming code) loads only when someone opens it.
const AssistantPanel = dynamic(() => import("./assistant-panel"), { ssr: false });

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

const FOLD_KEY = "trippr.nav";
const PHONE = "(max-width: 767px)";

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

/**
 * Open (icons and labels) or folded (icons only). On a laptop the choice is
 * remembered; on a phone the menu starts folded and slides out over the page.
 */
function useFold() {
  const [phone, setPhone] = useState(false);
  const [open, setOpen] = useState(true);
  useEffect(() => {
    const mq = window.matchMedia(PHONE);
    const sync = () => {
      setPhone(mq.matches);
      if (mq.matches) {
        setOpen(false);
        return;
      }
      let saved: string | null = null;
      try {
        saved = localStorage.getItem(FOLD_KEY);
      } catch {
        // Storage can be blocked; fall back to open.
      }
      setOpen(saved !== "in");
    };
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  const set = useCallback((next: boolean) => {
    setOpen(next);
    if (window.matchMedia(PHONE).matches) return;
    try {
      localStorage.setItem(FOLD_KEY, next ? "out" : "in");
    } catch {
      // Not remembered this time.
    }
  }, []);
  return { phone, open, set };
}

/** A small menu that opens beside its button; fixed so the scrolling sidebar can't clip it. */
function Popover({
  anchor,
  onClose,
  label,
  children,
  align = "top",
}: {
  anchor: HTMLElement | null;
  onClose: () => void;
  label: string;
  children: ReactNode;
  align?: "top" | "bottom";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  useEffect(() => {
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const left = Math.min(r.right + 8, window.innerWidth - 272);
    setPos(align === "top" ? { left, top: Math.max(8, r.top) } : { left, bottom: Math.max(8, window.innerHeight - r.bottom) });
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        anchor.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchor, align, onClose]);
  if (!pos) return null;
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      style={pos}
      className="fixed z-50 max-h-[80dvh] w-64 overflow-y-auto rounded-xl border border-board-3 bg-board-2 p-1.5 text-sm text-amber-soft shadow-2xl"
    >
      {children}
    </div>
  );
}

function MenuHeading({ children }: { children: ReactNode }) {
  return <div className="px-2.5 pb-1 pt-2 font-mono text-[10px] uppercase tracking-[0.2em] text-amber-soft/50">{children}</div>;
}

function MenuLink({ href, children, active, onPick }: { href: string; children: ReactNode; active?: boolean; onPick: () => void }) {
  return (
    <Link
      href={href}
      role="menuitem"
      onClick={onPick}
      className={`flex items-center gap-2 rounded-lg px-2.5 py-2 ${active ? "text-amber" : "hover:bg-board-3 hover:text-amber"}`}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {active ? <CheckIcon className="h-4 w-4 shrink-0 text-accent" /> : null}
    </Link>
  );
}

/** Trip and route in one switcher at the top of the menu. */
function TripSwitcher({ open, tripId, routeId }: { open: boolean; tripId: string; routeId?: string }) {
  const trip = useTrip(tripId);
  const trips = useTrips();
  const btn = useRef<HTMLButtonElement>(null);
  const [show, setShow] = useState(false);
  const close = useCallback(() => setShow(false), []);
  const name = trip.data?.trip.name ?? "Trip";
  const route = selectedRoute(trip.data?.routes, routeId);
  return (
    <>
      <button
        ref={btn}
        onClick={() => setShow((s) => !s)}
        aria-haspopup="menu"
        aria-expanded={show}
        aria-label={open ? undefined : `Trip: ${name}${route ? `, route ${route.name}` : ""}`}
        title={open ? undefined : `${name}${route ? ` · ${route.name}` : ""}`}
        data-testid="trip-switcher"
        className={`flex w-full items-center gap-2.5 rounded-lg border border-board-3 bg-board-2 text-left hover:border-amber-soft/40 ${open ? "p-1.5 pr-2" : "justify-center p-1"}`}
      >
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-board-3 font-mono text-[10px] font-semibold text-amber">{tripTile(name)}</span>
        {open ? (
          <>
            <span className="grid min-w-0 flex-1 leading-tight">
              <span className="truncate font-semibold text-amber">{name}</span>
              <span className="truncate text-xs text-amber-soft/70">{route ? route.name : "No routes yet"}</span>
            </span>
            <DownIcon className="h-4 w-4 shrink-0 text-amber-soft/70" />
          </>
        ) : null}
      </button>
      {show ? (
        <Popover anchor={btn.current} onClose={close} label="Switch trip or route">
          {trip.data?.routes.length ? (
            <>
              <MenuHeading>Routes in {name}</MenuHeading>
              {trip.data.routes.map((r) => (
                <MenuLink key={r.id} href={routeHref(tripId, r.id)} active={r.id === route?.id} onPick={close}>
                  {r.name}
                  {r.isCurrent ? <span className="ml-1.5 text-xs text-amber-soft/60">current</span> : null}
                </MenuLink>
              ))}
            </>
          ) : null}
          {trips.data && trips.data.length > 1 ? (
            <>
              <MenuHeading>Trips</MenuHeading>
              {trips.data.map((t) => (
                <MenuLink key={t.id} href={`/trips/${t.id}`} active={t.id === tripId} onPick={close}>
                  {t.name}
                </MenuLink>
              ))}
            </>
          ) : null}
          <div className="my-1 h-px bg-board-3" />
          <MenuLink href="/" onPick={close}>
            All trips
          </MenuLink>
        </Popover>
      ) : null}
    </>
  );
}

/** The route the menu points at: the one open now, else the trip's current route. */
function selectedRoute(routes: RouteSummary[] | undefined, routeId?: string) {
  if (!routes?.length) return undefined;
  return routes.find((r) => r.id === routeId) ?? routes.find((r) => r.isCurrent) ?? routes[0];
}

function NavItem({
  href,
  icon: Icon,
  label,
  active,
  open,
  extra,
}: {
  href: string;
  icon: Icon;
  label: string;
  active: boolean;
  open: boolean;
  extra?: ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-label={open ? undefined : label}
      title={open ? undefined : label}
      aria-current={active ? "page" : undefined}
      className={`flex h-9 items-center gap-3 rounded-lg text-sm transition-colors ${open ? "px-2.5" : "justify-center"} ${
        active
          ? "bg-board-3 font-medium text-amber shadow-[inset_2px_0_0_var(--color-accent)]"
          : "text-amber-soft hover:bg-board-2 hover:text-amber"
      }`}
    >
      <Icon className="h-[18px] w-[18px] shrink-0" />
      {open ? <span className="min-w-0 flex-1 truncate">{label}</span> : null}
      {open && extra ? extra : null}
    </Link>
  );
}

function Group({ label, open, children }: { label: string; open: boolean; children: ReactNode }) {
  return (
    <div className="grid gap-0.5">
      {open ? (
        <div className="px-2.5 pb-1 pt-1 font-mono text-[10px] uppercase tracking-[0.2em] text-amber-soft/50">{label}</div>
      ) : (
        <div className="mx-2.5 my-1.5 h-px bg-board-3" aria-hidden />
      )}
      {children}
    </div>
  );
}

function TripLinks({ tripId, routeId, path, open }: { tripId: string; routeId?: string; path: string; open: boolean }) {
  const trip = useTrip(tripId);
  const base = `/trips/${tripId}`;
  const route = selectedRoute(trip.data?.routes, routeId);
  const at = (seg: string) => path === `${base}/${seg}` || path.startsWith(`${base}/${seg}/`);
  return (
    <nav aria-label="Trip" className="grid gap-2">
      <Group label="Plan" open={open}>
        <NavItem href={base} icon={HomeIcon} label="Overview" active={path === base} open={open} />
        <NavItem
          href={route ? routeHref(tripId, route.id) : base}
          icon={RouteIcon}
          label={route ? `Route · ${route.name}` : "Route"}
          active={at("routes")}
          open={open}
        />
        <NavItem href={`${base}/itinerary`} icon={CalendarIcon} label="Itinerary" active={at("itinerary")} open={open} />
        <NavItem href={`${base}/map`} icon={MapIcon} label="Map" active={at("map")} open={open} />
      </Group>
      <Group label="Ideas" open={open}>
        <NavItem href={`${base}/library`} icon={StarIcon} label="Activities" active={at("library")} open={open} />
        <NavItem href={`${base}/inbox`} icon={InboxIcon} label="Inbox" active={at("inbox")} open={open} />
      </Group>
      <Group label="Book" open={open}>
        <NavItem href={`${base}/bookings`} icon={TicketIcon} label="Bookings" active={at("bookings")} open={open} />
      </Group>
      <Group label="Explore" open={open}>
        <NavItem href={`${base}/compare`} icon={CompareIcon} label="Compare routes" active={at("compare")} open={open} />
        <NavItem href={`${base}/paths`} icon={SignpostIcon} label="Find a path" active={at("paths")} open={open} />
        <NavItem href={`${base}/graph`} icon={GraphIcon} label="Graph" active={at("graph")} open={open} />
      </Group>
    </nav>
  );
}

/** Who else has this trip open right now. */
function Presence({ tripId, open }: { tripId: string; open: boolean }) {
  const { me } = useAuth();
  const { present, connected } = useTripLive(tripId);
  if (!connected) return null;
  const others = present.filter((p) => p.id !== me?.id);
  const names = others.map((p) => p.name).join(", ");
  return (
    <div
      className={`flex items-center gap-2 text-xs text-amber-soft/80 ${open ? "px-2.5" : "justify-center"}`}
      data-testid="presence"
      title={others.length ? `Also here: ${names}` : "Live: changes from others appear automatically"}
    >
      <span className="relative flex h-2 w-2 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ok opacity-60" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-ok" />
      </span>
      <span className="sr-only">Live updates on.</span>
      {others.length && open ? (
        <span className="flex -space-x-1.5" aria-label={`Also here: ${names}`}>
          {others.slice(0, 4).map((p) => (
            <span
              key={p.id}
              className="grid h-6 w-6 place-items-center rounded-full bg-amber-soft font-mono text-[10px] font-semibold text-board ring-2 ring-board"
            >
              {initials(p.name)}
            </span>
          ))}
          {others.length > 4 ? (
            <span className="grid h-6 w-6 place-items-center rounded-full bg-board-3 text-[10px] ring-2 ring-board">+{others.length - 4}</span>
          ) : null}
        </span>
      ) : null}
      {open ? <span>{others.length ? "here now" : "Live"}</span> : others.length ? <span aria-label={`${others.length} others here`}>{others.length}</span> : null}
    </div>
  );
}

function AskButton({ tripId, open }: { tripId: string; open: boolean }) {
  const [show, setShow] = useState(false);
  const close = useCallback(() => setShow(false), []);
  return (
    <>
      <button
        onClick={() => setShow(true)}
        aria-haspopup="dialog"
        aria-label={open ? undefined : "Ask about this trip"}
        title={open ? undefined : "Ask about this trip"}
        data-testid="ask-button"
        className={`flex h-9 items-center gap-2.5 rounded-lg bg-amber font-medium text-board hover:bg-amber-soft ${open ? "px-2.5" : "justify-center"}`}
      >
        <ChatIcon className="h-[18px] w-[18px] shrink-0" />
        {open ? <span className="truncate">Ask about this trip</span> : null}
      </button>
      {show ? <AssistantPanel tripId={tripId} onClose={close} /> : null}
    </>
  );
}

const THEMES: { id: ThemeChoice; label: string; icon: Icon }[] = [
  { id: "light", label: "Day", icon: SunIcon },
  { id: "dark", label: "Night", icon: MoonIcon },
  { id: "system", label: "Auto", icon: MonitorIcon },
];

function AccountMenu({ open }: { open: boolean }) {
  const { me, signOut } = useAuth();
  const btn = useRef<HTMLButtonElement>(null);
  const [show, setShow] = useState(false);
  const [theme, setTheme] = useState<ThemeChoice>("system");
  const close = useCallback(() => setShow(false), []);
  useEffect(() => setTheme(readTheme()), []);
  if (!me) return null;
  return (
    <>
      <button
        ref={btn}
        onClick={() => setShow((s) => !s)}
        aria-haspopup="menu"
        aria-expanded={show}
        aria-label={open ? undefined : `Account: ${me.name}`}
        title={open ? undefined : me.name}
        data-testid="account-menu"
        className={`flex h-10 w-full items-center gap-2.5 rounded-lg text-left hover:bg-board-2 ${open ? "px-1.5" : "justify-center"}`}
      >
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-board-3 font-mono text-[10px] font-semibold text-amber">{initials(me.name)}</span>
        {open ? (
          <>
            <span className="min-w-0 flex-1 truncate text-sm text-amber-soft">{me.name}</span>
            {me.isDemo ? <span className="rounded-full border border-amber/40 px-1.5 text-[10px] text-amber">demo</span> : null}
          </>
        ) : null}
      </button>
      {show ? (
        <Popover anchor={btn.current} onClose={close} label="Account" align="bottom">
          <div className="px-2.5 py-2">
            <div className="truncate font-medium text-amber">{me.name}</div>
            {me.isDemo ? <div className="text-xs text-amber-soft/70">Demo account, read-only</div> : null}
          </div>
          <MenuHeading>Appearance</MenuHeading>
          <div className="mx-1.5 mb-1 grid grid-cols-3 gap-1 rounded-lg bg-board p-1" role="group" aria-label="Appearance">
            {THEMES.map(({ id, label, icon: I }) => (
              <button
                key={id}
                aria-pressed={theme === id}
                onClick={() => {
                  applyTheme(id);
                  setTheme(id);
                }}
                className={`flex flex-col items-center gap-0.5 rounded-md py-1.5 text-[11px] ${theme === id ? "bg-board-3 text-amber" : "hover:text-amber"}`}
              >
                <I className="h-4 w-4" />
                {label}
              </button>
            ))}
          </div>
          <div className="my-1 h-px bg-board-3" />
          <Link href="/data" role="menuitem" onClick={close} className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 hover:bg-board-3 hover:text-amber">
            <DatabaseIcon className="h-4 w-4" /> Data sources
          </Link>
          <button
            role="menuitem"
            onClick={() => {
              close();
              void signOut();
            }}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-board-3 hover:text-amber"
          >
            <LogOutIcon className="h-4 w-4" /> Sign out
          </button>
        </Popover>
      ) : null}
    </>
  );
}

function Sidebar({
  open,
  phone,
  onFold,
  path,
}: {
  open: boolean;
  phone: boolean;
  onFold: () => void;
  path: string;
}) {
  const { tripId, routeId } = tripContext(path);
  const size = phone
    ? `fixed inset-y-0 left-0 z-40 ${open ? "w-64 shadow-2xl" : "w-14"}`
    : // Sticky always makes its own stacking layer, so it needs a z-index for its menus to sit above the page.
      `sticky top-0 z-40 shrink-0 ${open ? "w-60" : "w-14"}`;
  return (
    <aside
      className={`${size} flex h-dvh flex-col gap-3 overflow-y-auto overflow-x-hidden bg-board px-2 py-3 text-amber-soft transition-[width] duration-200 ease-out`}
      aria-label="Main menu"
      data-testid="sidebar"
      data-fold={open ? "out" : "in"}
    >
      <div className={`flex items-center gap-2 ${open ? "justify-between" : "flex-col"}`}>
        <Link href="/" className="flex items-center gap-2 px-1 font-mono text-sm font-semibold tracking-[0.2em] text-amber" aria-label="Trippr, all trips">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-amber text-board">T</span>
          {open ? "TRIPPR" : null}
        </Link>
        <button
          onClick={onFold}
          aria-label={open ? "Fold menu" : "Unfold menu"}
          aria-expanded={open}
          title={open ? "Fold menu" : "Unfold menu"}
          data-testid="fold-menu"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-amber-soft hover:bg-board-3 hover:text-amber"
        >
          <PanelIcon className={`h-[18px] w-[18px] transition-transform duration-200 ${open ? "" : "-scale-x-100"}`} />
        </button>
      </div>

      {tripId ? (
        <>
          <TripSwitcher open={open} tripId={tripId} routeId={routeId} />
          <TripLinks tripId={tripId} routeId={routeId} path={path} open={open} />
        </>
      ) : (
        <nav aria-label="Trippr" className="grid gap-0.5">
          <NavItem href="/" icon={SuitcaseIcon} label="My trips" active={path === "/"} open={open} />
          <NavItem href="/data" icon={DatabaseIcon} label="Data sources" active={path.startsWith("/data")} open={open} />
        </nav>
      )}

      <div className="mt-auto grid gap-2 pt-2">
        {tripId ? (
          <>
            <Presence tripId={tripId} open={open} />
            <AskButton tripId={tripId} open={open} />
          </>
        ) : null}
        <AccountMenu open={open} />
      </div>
    </aside>
  );
}

/** Logo only, for pages people can see before signing in. */
function PublicBar() {
  return (
    <header className="bg-board">
      <div className="mx-auto flex max-w-6xl items-center px-4 py-2.5">
        <Link href="/" className="flex items-center gap-2 font-mono text-sm font-semibold tracking-[0.2em] text-amber">
          <span className="grid h-7 w-7 place-items-center rounded-md bg-amber text-board">T</span>
          TRIPPR
        </Link>
      </div>
    </header>
  );
}

/**
 * Every signed-in page sits beside one left menu. It folds to an icon rail;
 * on phones the rail stays and the full menu slides out over the page.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const path = usePathname();
  const fold = useFold();
  const { phone, set } = fold;

  // On a phone, following a link closes the menu.
  useEffect(() => {
    if (phone) set(false);
  }, [path, phone, set]);

  if (status === "loading") return <>{children}</>;
  if (status === "signedOut") {
    return (
      <>
        <PublicBar />
        {children}
      </>
    );
  }
  return (
    <div className="flex min-h-dvh">
      <Sidebar open={fold.open} phone={phone} onFold={() => set(!fold.open)} path={path} />
      {phone && fold.open ? (
        <button aria-label="Close menu" className="fixed inset-0 z-30 bg-board/50" onClick={() => set(false)} />
      ) : null}
      <div className={`min-w-0 flex-1 ${phone ? "pl-14" : ""}`}>{children}</div>
    </div>
  );
}
