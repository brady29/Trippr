"use client";

import type { Invite, Member, Role, RouteSummary, RouteView, TripDetail } from "@trippr/contracts";
import { hasRole } from "@trippr/contracts";
import { shortDate } from "@trippr/rules";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { BoardHeader, BoardStat, RequireAuth, TopBar } from "@/components/shell";
import { useToast } from "@/components/toast";
import { TripNav } from "@/components/trip-nav";
import { Button, ChecksBadge, ErrorNote, Input, Panel, Select, Spinner, Tag } from "@/components/ui";
import { cad } from "@/components/budget-panel";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { keys, useTrip } from "@/lib/queries";

function RouteCard({
  route,
  trip,
  selected,
  onSelect,
}: {
  route: RouteSummary;
  trip: TripDetail;
  selected: boolean;
  onSelect: (checked: boolean) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const canEdit = hasRole(trip.role, "editor");
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(route.name);
  const [tags, setTags] = useState(route.tags.join(", "));

  const refresh = () => qc.invalidateQueries({ queryKey: keys.trip(trip.trip.id) });
  const onError = (e: unknown) => toast(e instanceof Error ? e.message : "That didn't save", "error");

  const patch = useMutation({
    mutationFn: (body: { name?: string; tags?: string[]; isCurrent?: true }) =>
      api<RouteView>(`/routes/${route.id}`, { method: "PATCH", body: { ...body, version: route.version } }),
    onSuccess: (view) => {
      qc.setQueryData(keys.route(route.id), view);
      setEditing(false);
      void refresh();
    },
    onError: (e) => {
      onError(e);
      void refresh();
    },
  });
  const duplicate = useMutation({
    mutationFn: () => api<RouteView>(`/trips/${trip.trip.id}/routes`, { method: "POST", body: { fromRouteId: route.id } }),
    onSuccess: (view) => {
      qc.setQueryData(keys.route(view.route.id), view);
      void refresh();
      toast(`Created "${view.route.name}"`, "ok");
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: () => api(`/routes/${route.id}`, { method: "DELETE" }),
    onSuccess: () => void refresh(),
    onError,
  });

  return (
    <li className="ticket flex flex-col sm:flex-row" data-testid="route-card">
      <div className="flex min-w-0 flex-1 flex-col gap-3 p-4">
        <div className="flex items-start gap-3">
          <input
            type="checkbox"
            aria-label={`Select ${route.name} to compare`}
            checked={selected}
            onChange={(e) => onSelect(e.target.checked)}
            className="mt-1.5 h-4 w-4 accent-[#0f151d]"
          />
          <div className="min-w-0 flex-1">
            {editing ? (
              <form
                className="space-y-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  patch.mutate({
                    name: name.trim() || route.name,
                    tags: tags
                      .split(",")
                      .map((t) => t.trim().toLowerCase())
                      .filter(Boolean),
                  });
                }}
              >
                <Input aria-label="Route name" value={name} onChange={(e) => setName(e.target.value)} />
                <Input aria-label="Tags, comma separated" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="budget, older" />
                <div className="flex gap-2">
                  <Button size="sm" type="submit" variant="primary" disabled={patch.isPending}>
                    Save
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                    Cancel
                  </Button>
                </div>
              </form>
            ) : (
              <>
                <Link href={`/routes/${route.id}`} className="text-lg font-semibold hover:underline">
                  {route.name}
                </Link>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {route.isCurrent ? <Tag tone="dark">current</Tag> : null}
                  {route.tags.filter((t) => !(route.isCurrent && t === "current")).map((t) => (
                    <Tag key={t}>{t}</Tag>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
        <p className="line-clamp-2 text-sm text-ink-soft">{route.cities.join(" → ") || "No stops yet"}</p>
        {route.derivedFrom ? <p className="text-xs text-ink-faint">Duplicated from {route.derivedFrom.name}</p> : null}
        <div className="flex flex-wrap gap-2">
          <Link href={`/routes/${route.id}`}>
            <Button size="sm" variant="primary">
              Open
            </Button>
          </Link>
          {canEdit ? (
            <>
              <Button size="sm" onClick={() => duplicate.mutate()} disabled={duplicate.isPending}>
                Duplicate
              </Button>
              {!route.isCurrent ? (
                <Button size="sm" onClick={() => patch.mutate({ isCurrent: true })} disabled={patch.isPending}>
                  Set as current
                </Button>
              ) : null}
              {!editing ? (
                <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
                  Rename / tag
                </Button>
              ) : null}
            </>
          ) : null}
          {trip.role === "owner" ? (
            <Button
              size="sm"
              variant="danger"
              disabled={remove.isPending}
              onClick={() => {
                if (window.confirm(`Delete "${route.name}" and its stops? This can't be undone.`)) remove.mutate();
              }}
            >
              Delete
            </Button>
          ) : null}
        </div>
      </div>
      <div className="ticket-perf flex shrink-0 flex-row items-center justify-between gap-4 p-4 sm:w-44 sm:flex-col sm:items-start sm:justify-center">
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em] text-ink-faint">Nights</div>
          <div className="font-mono text-2xl font-semibold">{route.totalNights}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em] text-ink-faint">Home</div>
          <div className="font-mono text-sm">{shortDate(route.returnDate)}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em] text-ink-faint">Per person</div>
          <div className="font-mono text-sm" data-testid="route-per-person">
            {cad(route.perPersonCad)}
          </div>
        </div>
        <ChecksBadge level={route.checksLevel} />
      </div>
    </li>
  );
}

/** Owner sets how many people are travelling; it drives every group budget. */
function GroupSizePanel({ tripId, travellers }: { tripId: string; travellers: number }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [value, setValue] = useState(String(travellers));
  const save = useMutation({
    mutationFn: (n: number) => api(`/trips/${tripId}`, { method: "PATCH", body: { travellers: n } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.trip(tripId) });
      void qc.invalidateQueries({ queryKey: ["route"] });
      void qc.invalidateQueries({ queryKey: ["compare"] });
      toast("Group size saved", "ok");
    },
    onError: (e) => toast(e instanceof Error ? e.message : "That didn't save", "error"),
  });
  const n = Number(value);
  const valid = Number.isInteger(n) && n >= 1 && n <= 20;
  return (
    <Panel title="Group size">
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && n !== travellers) save.mutate(n);
        }}
      >
        <Input
          type="number"
          min={1}
          max={20}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label="Number of travellers"
          className="w-20"
        />
        <span className="text-sm text-ink-soft">travellers</span>
        <Button type="submit" size="sm" disabled={!valid || n === travellers || save.isPending} className="ml-auto">
          Save
        </Button>
      </form>
      <p className="mt-2 text-xs text-ink-faint">Group budgets multiply the per-person estimate by this.</p>
    </Panel>
  );
}

function InvitePanel({ tripId }: { tripId: string }) {
  const [role, setRole] = useState<"editor" | "viewer">("editor");
  const [invite, setInvite] = useState<Invite | null>(null);
  const toast = useToast();
  const create = useMutation({
    mutationFn: () => api<Invite>(`/trips/${tripId}/invites`, { method: "POST", body: { role } }),
    onSuccess: setInvite,
  });
  return (
    <Panel title="Invite friends">
      <div className="flex gap-2">
        <Select aria-label="Role for the invite" value={role} onChange={(e) => setRole(e.target.value as "editor" | "viewer")}>
          <option value="editor">Editor: can change routes</option>
          <option value="viewer">Viewer: can vote and comment</option>
        </Select>
        <Button variant="primary" onClick={() => create.mutate()} disabled={create.isPending}>
          Create link
        </Button>
      </div>
      {invite ? (
        <div className="mt-3 space-y-2">
          <Input readOnly value={invite.url} onFocus={(e) => e.currentTarget.select()} aria-label="Invite link" />
          <div className="flex items-center justify-between text-xs text-ink-soft">
            <span>
              {invite.role} link, expires {shortDate(invite.expiresAt.slice(0, 10))}
            </span>
            <button
              className="font-medium text-sky hover:underline"
              onClick={() => {
                void navigator.clipboard?.writeText(invite.url).then(() => toast("Link copied", "ok"));
              }}
            >
              Copy
            </button>
          </div>
        </div>
      ) : null}
      {create.error ? <ErrorNote error={create.error} /> : null}
    </Panel>
  );
}

/** Who is on the trip. Owners change roles and remove people; anyone can leave. */
function MembersPanel({ trip }: { trip: TripDetail }) {
  const qc = useQueryClient();
  const router = useRouter();
  const toast = useToast();
  const { me } = useAuth();
  const tripId = trip.trip.id;
  const isOwner = trip.role === "owner";
  const owners = trip.members.filter((m) => m.role === "owner").length;
  const onError = (e: unknown) => toast(e instanceof Error ? e.message : "That didn't save", "error");

  const setRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: Role }) =>
      api<Member[]>(`/trips/${tripId}/members/${userId}`, { method: "PUT", body: { role } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.trip(tripId) }),
    onError,
  });
  const remove = useMutation({
    mutationFn: (userId: string) => api<Member[]>(`/trips/${tripId}/members/${userId}`, { method: "DELETE" }),
    onSuccess: (_data, userId) => {
      if (userId === me?.id) {
        void qc.invalidateQueries({ queryKey: keys.trips });
        router.push("/");
        return;
      }
      void qc.invalidateQueries({ queryKey: keys.trip(tripId) });
    },
    onError,
  });

  return (
    <Panel title="Travellers">
      <ul className="space-y-2" data-testid="members">
        {trip.members.map((m) => {
          const self = m.id === me?.id;
          const lastOwner = m.role === "owner" && owners === 1;
          return (
            <li key={m.id} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate">
                {m.name}
                {self ? <span className="text-ink-faint"> (you)</span> : null}
              </span>
              {isOwner && !self ? (
                <Select
                  aria-label={`Role for ${m.name}`}
                  value={m.role}
                  disabled={setRole.isPending}
                  onChange={(e) => setRole.mutate({ userId: m.id, role: e.target.value as Role })}
                  className="h-8 text-xs"
                >
                  <option value="viewer">viewer</option>
                  <option value="editor">editor</option>
                  <option value="owner">owner</option>
                </Select>
              ) : (
                <Tag tone={m.role === "owner" ? "dark" : "plain"}>{m.role}</Tag>
              )}
              {(isOwner && !self) || (self && !lastOwner && !me?.isDemo) ? (
                <button
                  className="text-xs text-err hover:underline disabled:opacity-50"
                  disabled={remove.isPending}
                  aria-label={self ? "Leave this trip" : `Remove ${m.name}`}
                  onClick={() => {
                    const question = self
                      ? `Leave ${trip.trip.name}? You'll need a new invite to come back.`
                      : `Remove ${m.name} from ${trip.trip.name}?`;
                    if (window.confirm(question)) remove.mutate(m.id);
                  }}
                >
                  {self ? "Leave" : "Remove"}
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {isOwner && owners === 1 ? (
        <p className="mt-3 text-xs text-ink-faint">To leave, first make someone else an owner.</p>
      ) : null}
    </Panel>
  );
}

function TripHome({ tripId }: { tripId: string }) {
  const trip = useTrip(tripId);
  const qc = useQueryClient();
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>([]);
  const create = useMutation({
    mutationFn: () => api<RouteView>(`/trips/${tripId}/routes`, { method: "POST", body: { name: "New route" } }),
    onSuccess: (view) => {
      qc.setQueryData(keys.route(view.route.id), view);
      router.push(`/routes/${view.route.id}`);
    },
  });

  if (trip.isPending) return <div className="mx-auto max-w-6xl px-4 py-8"><Spinner /></div>;
  if (trip.error) return <div className="mx-auto max-w-6xl px-4 py-8"><ErrorNote error={trip.error} /></div>;
  const t = trip.data;
  const current = t.routes.find((r) => r.isCurrent);

  return (
    <>
      <BoardHeader
        eyebrow={`Trip · ${t.role}`}
        title={t.trip.name}
        meta={
          <>
            <BoardStat label="Departs" value={shortDate(t.trip.startDate)} />
            {t.trip.homeCity ? <BoardStat label="From" value={t.trip.homeCity} /> : null}
            <BoardStat label="Routes" value={t.routes.length} />
            <BoardStat label="Travellers" value={t.trip.travellers ?? 1} />
            {current ? <BoardStat label="Current" value={`${current.name} · ${current.totalNights} nights`} /> : null}
          </>
        }
      />
      <main className="mx-auto grid grid-cols-1 max-w-6xl gap-6 px-4 py-6 lg:grid-cols-[1fr_320px]">
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-soft">Routes</h2>
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={selected.length !== 2}
                onClick={() => router.push(`/trips/${tripId}/compare?a=${selected[0]}&b=${selected[1]}`)}
              >
                Compare {selected.length === 2 ? "selected" : `(pick ${2 - selected.length > 0 ? 2 - selected.length : 0} more)`}
              </Button>
              {hasRole(t.role, "editor") ? (
                <Button size="sm" variant="primary" onClick={() => create.mutate()} disabled={create.isPending}>
                  New route
                </Button>
              ) : null}
            </div>
          </div>
          <ul className="space-y-3">
            {t.routes.map((r) => (
              <RouteCard
                key={`${r.id}-${r.version}`}
                route={r}
                trip={t}
                selected={selected.includes(r.id)}
                onSelect={(checked) =>
                  setSelected((s) => (checked ? [...s.filter((x) => x !== r.id), r.id].slice(-2) : s.filter((x) => x !== r.id)))
                }
              />
            ))}
          </ul>
        </section>
        <aside className="space-y-4">
          {t.role === "owner" ? (
            <GroupSizePanel key={t.trip.travellers ?? 1} tripId={tripId} travellers={t.trip.travellers ?? 1} />
          ) : null}
          {t.role === "owner" ? <InvitePanel tripId={tripId} /> : null}
          <MembersPanel trip={t} />
        </aside>
      </main>
    </>
  );
}

export default function TripPage() {
  const { tripId } = useParams<{ tripId: string }>();
  const trip = useTrip(tripId);
  return (
    <>
      <TopBar>
        <TripNav tripId={tripId} tripName={trip.data?.trip.name} />
      </TopBar>
      <RequireAuth>
        <TripHome tripId={tripId} />
      </RequireAuth>
    </>
  );
}
