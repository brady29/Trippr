"use client";

import type { Activity, CreateActivityBody } from "@trippr/contracts";
import { isFixedDate, whenLabel, type When } from "@trippr/rules";
import { useState, type ReactNode } from "react";
import {
  useAddComment,
  useComments,
  useCreateActivity,
  useDeleteActivity,
  useUpdateActivity,
  useVote,
} from "@/lib/queries";
import { ChatIcon, StarIcon, ThumbDownIcon, ThumbUpIcon } from "./icons";
import { PLACE_STATUS_LABEL, PlaceEditor } from "./place-editor";
import { PlaceLinks } from "./place-links";
import { Button, ErrorNote, Input, Label, Select, Spinner, Tag } from "./ui";

function Comments({ activityId, canComment }: { activityId: string; canComment: boolean }) {
  const comments = useComments(activityId, true);
  const add = useAddComment(activityId);
  const [text, setText] = useState("");
  return (
    <div className="mt-2 space-y-2 rounded-lg bg-paper p-2.5">
      {comments.isPending ? <Spinner label="Loading comments" /> : null}
      {comments.data?.length === 0 ? <p className="text-xs text-ink-faint">No comments yet.</p> : null}
      <ul className="space-y-1.5">
        {comments.data?.map((c) => (
          <li key={c.id} className="text-sm">
            <span className="font-medium">{c.author.name}</span> <span className="text-ink-soft">{c.text}</span>
          </li>
        ))}
      </ul>
      {canComment ? (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!text.trim()) return;
            add.mutate(text.trim(), { onSuccess: () => setText("") });
          }}
        >
          <Input
            value={text}
            maxLength={280}
            onChange={(e) => setText(e.target.value)}
            placeholder="Short comment"
            aria-label="Add a comment"
            className="h-9"
          />
          <Button size="sm" type="submit" disabled={add.isPending || !text.trim()} className="h-9">
            Post
          </Button>
        </form>
      ) : null}
    </div>
  );
}

/** One activity with votes, comments and an optional control (the planned toggle). */
export function ActivityItem({
  activity,
  canVote,
  leading,
  footer,
  canEdit = false,
}: {
  activity: Activity;
  canVote: boolean;
  leading?: ReactNode;
  footer?: ReactNode;
  /** Editors can change or delete the activity everywhere it appears. */
  canEdit?: boolean;
}) {
  const vote = useVote();
  const remove = useDeleteActivity();
  const [showComments, setShowComments] = useState(false);
  const [editing, setEditing] = useState(false);
  const [placing, setPlacing] = useState(false);
  const status = activity.placeStatus ?? "unplaced";
  const cast = (value: -1 | 1) => vote.mutate({ activityId: activity.id, value: activity.myVote === value ? 0 : value });
  if (editing) {
    return (
      <li data-testid="activity-item">
        <ActivityForm
          mode="edit"
          initial={activity}
          tripId=""
          cityCode={activity.cityCode}
          cityName={activity.cityName}
          onDone={() => setEditing(false)}
        />
      </li>
    );
  }
  return (
    <li className="rounded-xl border border-line bg-card p-3" data-testid="activity-item">
      <div className="flex items-start gap-3">
        {leading}
        <div className="min-w-0 flex-1">
          <div className="font-medium leading-snug">
            {activity.url ? (
              <a href={activity.url} target="_blank" rel="noreferrer" className="hover:underline">
                {activity.title}
              </a>
            ) : (
              activity.title
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-ink-soft">
            {isFixedDate(activity.when) ? (
              <span className="inline-flex items-center gap-1 font-medium text-stamp">
                <StarIcon className="h-3 w-3" />
                {whenLabel(activity.when)}
              </span>
            ) : null}
            {activity.costCad != null ? <span>${activity.costCad} CAD</span> : null}
            {activity.tags.map((t) => (
              <Tag key={t}>{t}</Tag>
            ))}
            {canEdit && (status === "check" || status === "not_found") ? (
              <button onClick={() => setPlacing(true)} className="font-medium text-stamp hover:underline">
                {status === "check" ? "Check the pin" : "Not found on the map"}
              </button>
            ) : null}
          </div>
          <PlaceLinks activity={activity} className="mt-1.5 text-xs" />
          {footer}
        </div>
        <div className="flex shrink-0 flex-col items-center gap-0.5">
          <button
            aria-label={`Vote up ${activity.title}`}
            aria-pressed={activity.myVote === 1}
            disabled={!canVote}
            onClick={() => cast(1)}
            className={`rounded p-1 ${activity.myVote === 1 ? "bg-ok/15 text-ok" : "text-ink-faint hover:text-ink"} disabled:opacity-40`}
          >
            <ThumbUpIcon />
          </button>
          <span className="font-mono text-xs font-semibold" data-testid="votes">
            {activity.votes}
          </span>
          <button
            aria-label={`Vote down ${activity.title}`}
            aria-pressed={activity.myVote === -1}
            disabled={!canVote}
            onClick={() => cast(-1)}
            className={`rounded p-1 ${activity.myVote === -1 ? "bg-err/15 text-err" : "text-ink-faint hover:text-ink"} disabled:opacity-40`}
          >
            <ThumbDownIcon />
          </button>
        </div>
      </div>
      <div className="mt-2 flex items-center gap-3 text-xs">
        <button
          onClick={() => setShowComments((s) => !s)}
          className="inline-flex items-center gap-1 text-ink-soft hover:text-ink"
          aria-expanded={showComments}
        >
          <ChatIcon className="h-3.5 w-3.5" />
          {activity.commentCount} comment{activity.commentCount === 1 ? "" : "s"}
        </button>
        {canEdit ? (
          <>
            <button
              onClick={() => setPlacing((p) => !p)}
              className="ml-auto text-sky hover:underline"
              aria-expanded={placing}
              aria-label={`Pin ${activity.title} on the map`}
              title={PLACE_STATUS_LABEL[status]}
            >
              {activity.lat != null ? "Pin" : "Find on map"}
            </button>
            <button onClick={() => setEditing(true)} className="text-sky hover:underline" aria-label={`Edit ${activity.title}`}>
              Edit
            </button>
            <button
              onClick={() => {
                if (window.confirm(`Delete "${activity.title}" from the library? It's removed from every route that planned it.`)) {
                  remove.mutate(activity.id);
                }
              }}
              disabled={remove.isPending}
              className="text-err hover:underline disabled:opacity-50"
              aria-label={`Delete ${activity.title}`}
            >
              Delete
            </button>
          </>
        ) : null}
      </div>
      {placing && canEdit ? <PlaceEditor activity={activity} onClose={() => setPlacing(false)} /> : null}
      {showComments ? <Comments activityId={activity.id} canComment={canVote} /> : null}
    </li>
  );
}

type WhenKind = "none" | "on" | "range" | "weekdays";
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const whenKind = (when: When | null | undefined): WhenKind =>
  !when ? "none" : "on" in when ? "on" : "from" in when ? "range" : "weekdays";

/** Create an activity in a city; it then appears in every route that stops there. */
export function NewActivityForm({ tripId, cityCode, cityName, onCreated }: { tripId: string; cityCode: string; cityName: string; onCreated?: () => void }) {
  return <ActivityForm mode="create" tripId={tripId} cityCode={cityCode} cityName={cityName} onDone={onCreated} />;
}

/** Add an activity to a city's library, or edit one everywhere it appears. */
export function ActivityForm({
  mode,
  initial,
  tripId,
  cityCode,
  cityName,
  onDone,
}: {
  mode: "create" | "edit";
  initial?: Activity;
  tripId: string;
  cityCode: string;
  cityName: string;
  onDone?: () => void;
}) {
  const create = useCreateActivity();
  const update = useUpdateActivity();
  const pending = create.isPending || update.isPending;
  const error = create.error ?? update.error;
  const w = initial?.when ?? null;
  const [title, setTitle] = useState(initial?.title ?? "");
  const [tags, setTags] = useState(initial?.tags.join(", ") ?? "");
  const [url, setUrl] = useState(initial?.url ?? "");
  const [website, setWebsite] = useState(initial?.website ?? "");
  const [ticketUrl, setTicketUrl] = useState(initial?.ticketUrl ?? "");
  const [reserveUrl, setReserveUrl] = useState(initial?.reserveUrl ?? "");
  const [moreLinks, setMoreLinks] = useState(Boolean(initial?.website || initial?.ticketUrl || initial?.reserveUrl));
  const [cost, setCost] = useState(initial?.costCad != null ? String(initial.costCad) : "");
  const [kind, setKind] = useState<WhenKind>(whenKind(w));
  const [on, setOn] = useState(w && "on" in w ? w.on : "");
  const [from, setFrom] = useState(w && "from" in w ? w.from : "");
  const [to, setTo] = useState(w && "to" in w ? w.to : "");
  const [days, setDays] = useState<number[]>(w && "weekdays" in w ? w.weekdays : []);

  const when = (): When | null => {
    if (kind === "on" && on) return { on };
    if (kind === "range" && from && to) return { from, to };
    if (kind === "weekdays" && days.length) return { weekdays: days };
    return null;
  };

  const fields = () => ({
    title: title.trim(),
    tags: tags
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean),
    when: when(),
    url: url.trim() || null,
    costCad: cost ? Number(cost) : null,
    website: website.trim() || null,
    ticketUrl: ticketUrl.trim() || null,
    reserveUrl: reserveUrl.trim() || null,
  });

  return (
    <form
      className={`space-y-2.5 rounded-xl border p-3 ${mode === "edit" ? "border-ink-faint bg-card" : "border-dashed border-ink-faint/60"}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (mode === "edit" && initial) {
          update.mutate({ id: initial.id, body: fields() }, { onSuccess: () => onDone?.() });
          return;
        }
        const body: CreateActivityBody = { tripId, cityCode, ...fields() };
        create.mutate(body, {
          onSuccess: () => {
            setTitle("");
            setTags("");
            setUrl("");
            setWebsite("");
            setTicketUrl("");
            setReserveUrl("");
            setCost("");
            setKind("none");
            onDone?.();
          },
        });
      }}
    >
      <div className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-soft">
        {mode === "edit" ? `Edit activity in ${cityName}` : `Add an activity in ${cityName}`}
      </div>
      <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What is it?" aria-label="Activity title" required />
      <div className="grid grid-cols-2 gap-2">
        <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="Tags: food, tech" aria-label="Tags" />
        <Input type="number" min={0} step="1" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="Cost (CAD)" aria-label="Cost in CAD" />
      </div>
      <Input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Where you saw it: a video or article (optional)" aria-label="Link" />
      {moreLinks ? (
        <div className="space-y-2">
          <Input type="url" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="Official website" aria-label="Website" />
          <Input type="url" value={ticketUrl} onChange={(e) => setTicketUrl(e.target.value)} placeholder="Ticket page" aria-label="Ticket page" />
          <Input type="url" value={reserveUrl} onChange={(e) => setReserveUrl(e.target.value)} placeholder="Reservation page" aria-label="Reservation page" />
        </div>
      ) : (
        <button type="button" onClick={() => setMoreLinks(true)} className="text-xs text-sky hover:underline">
          Add website, tickets or reservations
        </button>
      )}
      <div>
        <Label htmlFor={`when-${cityCode}`}>Fixed date</Label>
        <Select id={`when-${cityCode}`} value={kind} onChange={(e) => setKind(e.target.value as WhenKind)} className="w-full">
          <option value="none">Any day</option>
          <option value="on">On one date</option>
          <option value="range">Between two dates</option>
          <option value="weekdays">On certain weekdays</option>
        </Select>
      </div>
      {kind === "on" ? <Input type="date" value={on} onChange={(e) => setOn(e.target.value)} aria-label="Date" required /> : null}
      {kind === "range" ? (
        <div className="grid grid-cols-2 gap-2">
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" required />
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" required />
        </div>
      ) : null}
      {kind === "weekdays" ? (
        <div className="flex flex-wrap gap-1">
          {WEEKDAYS.map((d, i) => (
            <button
              type="button"
              key={d}
              aria-pressed={days.includes(i)}
              onClick={() => setDays((s) => (s.includes(i) ? s.filter((x) => x !== i) : [...s, i].sort()))}
              className={`rounded-md border px-2 py-1 text-xs ${days.includes(i) ? "border-board bg-board text-amber" : "border-line"}`}
            >
              {d}
            </button>
          ))}
        </div>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" size="sm" disabled={pending || !title.trim()}>
          {mode === "edit" ? "Save changes" : `Add to ${cityName}`}
        </Button>
        {mode === "edit" ? (
          <Button size="sm" variant="ghost" onClick={() => onDone?.()}>
            Cancel
          </Button>
        ) : null}
      </div>
      {error ? <ErrorNote error={error} /> : null}
    </form>
  );
}
