"use client";

import {
  ASSISTANT_MAX_MESSAGE,
  ASSISTANT_SUGGESTIONS,
  assistantFocusIds,
  hasRefs,
  type ApiError as ApiErrorBody,
  type AssistantEvent,
  type AssistantRefLabel,
  type AssistantThread,
  type AssistantTurn,
} from "@trippr/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, API_URL, ApiError, authHeaders } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { XIcon } from "./icons";
import { Button, ErrorNote, Spinner } from "./ui";

/**
 * The Ask panel: questions about the trip, answered by the trip assistant
 * (Claude with read-only tools over the trip). Loaded on demand from the
 * Ask button, so none of this is in the main bundle.
 */

const threadKey = (tripId: string) => ["assistant", tripId] as const;

/** Map node ids for one or more references, as the Map tab's ?focus= expects. */
const mapHref = (tripId: string, ids: string[]) => `/trips/${tripId}/map?focus=${ids.map(encodeURIComponent).join(",")}`;

const nodeId = (l: AssistantRefLabel) =>
  ({ stop: `stop:${l.id}`, activity: `act:${l.id}`, leg: `leg:${l.id}`, hotel: `hotel:${l.id}`, city: `city:${l.id}` })[l.kind];

const CHIP_STYLE: Record<AssistantRefLabel["kind"], string> = {
  stop: "border-board/30 bg-board/5",
  city: "border-board/30 bg-board/5",
  activity: "border-tag-food/50 bg-tag-food/10",
  leg: "border-sky/40 bg-sky/10",
  hotel: "border-ok/40 bg-ok/10",
};
const CHIP_KIND: Record<AssistantRefLabel["kind"], string> = { stop: "Stop", city: "City", activity: "Activity", leg: "Ticket", hotel: "Hotel" };

/** A recorded conversation shown to the demo account, which can't ask (it would spend real money). */
const DEMO_TURNS: AssistantTurn[] = [
  { role: "user", text: "Is there a train from Chengdu to Chongqing?", at: "" },
  {
    role: "assistant",
    text: "Yes. High-speed trains link Chengdu and Chongqing many times a day and take about 1 to 1.5 hours. Chongqing is already on the current route, so a couple of nights in Chengdu would fit just before it.",
    at: "",
    tools: ["Looking for a way from CTU to CKG…", "Looking at the route…"],
    labels: [
      { kind: "city", id: "CTU", label: "Chengdu" },
      { kind: "city", id: "CKG", label: "Chongqing" },
    ],
    refs: { stopIds: [], activityIds: [], legIds: [], hotelIds: [], cityCodes: ["CTU", "CKG"] },
  },
  { role: "user", text: "Which days are free?", at: "" },
  {
    role: "assistant",
    text: "Most days after Tokyo have nothing planned yet. Arrival days are taken up by travel, so the best open days for a day trip are the middle days of the longer stops, like Beijing and Chongqing.",
    at: "",
    tools: ["Checking the day-by-day plan…"],
    labels: [
      { kind: "city", id: "BJS", label: "Beijing" },
      { kind: "city", id: "CKG", label: "Chongqing" },
    ],
    refs: { stopIds: [], activityIds: [], legIds: [], hotelIds: [], cityCodes: ["BJS", "CKG"] },
  },
];

/** Posts a question and reads the server-sent events until the answer is done. */
async function streamAnswer(tripId: string, message: string, signal: AbortSignal, onEvent: (event: AssistantEvent) => void) {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/trips/${tripId}/assistant`, {
      method: "POST",
      headers: { ...(await authHeaders()), "content-type": "application/json" },
      body: JSON.stringify({ message }),
      signal,
    });
  } catch (e) {
    if (signal.aborted) throw e;
    throw new ApiError(0, "network", "Can't reach the Trippr API. Check your connection.");
  }
  if (!res.ok || !res.body) {
    let body: ApiErrorBody | undefined;
    try {
      body = (await res.json()) as ApiErrorBody;
    } catch {
      body = undefined;
    }
    throw new ApiError(res.status, body?.error.code ?? "internal", body?.error.message ?? `Request failed (${res.status})`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut: number;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const data = /^data: (.+)$/m.exec(block)?.[1];
      if (data) onEvent(JSON.parse(data) as AssistantEvent);
    }
  }
}

function ToolLines({ tools }: { tools: string[] }) {
  if (!tools.length) return null;
  return (
    <ul className="mb-1.5 space-y-0.5" aria-label="What the assistant looked at">
      {tools.map((t, i) => (
        <li key={i} className="font-mono text-[11px] text-ink-faint">
          {t}
        </li>
      ))}
    </ul>
  );
}

function Answer({ turn, tripId, onNavigate }: { turn: AssistantTurn; tripId: string; onNavigate: () => void }) {
  const labels = turn.labels ?? [];
  return (
    <div className="rounded-2xl rounded-tl-sm border border-line bg-card px-3.5 py-3 text-sm" data-testid="assistant-answer">
      <ToolLines tools={turn.tools ?? []} />
      {turn.text ? <div className="whitespace-pre-wrap leading-relaxed">{turn.text}</div> : null}
      {turn.error ? <p className="mt-1 text-xs text-err">{turn.error}</p> : null}
      {labels.length ? (
        <div className="mt-2.5 flex flex-wrap gap-1.5" aria-label="Things this answer is about">
          {labels.map((l) => (
            <Link
              key={`${l.kind}:${l.id}`}
              href={mapHref(tripId, [nodeId(l)])}
              onClick={onNavigate}
              className={`inline-flex max-w-full items-center gap-1 truncate rounded-full border px-2 py-0.5 text-xs hover:border-ink-faint ${CHIP_STYLE[l.kind]}`}
              title={`${CHIP_KIND[l.kind]}: show on the map`}
            >
              <span className="text-[10px] uppercase tracking-wide text-ink-faint">{CHIP_KIND[l.kind]}</span>
              <span className="truncate">{l.label}</span>
            </Link>
          ))}
        </div>
      ) : null}
      {turn.citations?.length ? (
        <ol className="mt-2.5 space-y-1 border-t border-line pt-2 text-xs" aria-label="Sources">
          {turn.citations.map((c, i) => (
            <li key={c.url} className="truncate">
              <span className="mr-1 font-mono text-ink-faint">[{i + 1}]</span>
              <a href={c.url} target="_blank" rel="noopener noreferrer" className="text-sky underline-offset-2 hover:underline">
                {c.title || new URL(c.url).hostname}
              </a>
            </li>
          ))}
        </ol>
      ) : null}
      {hasRefs(turn.refs) ? (
        <Link
          href={mapHref(tripId, assistantFocusIds(turn.refs))}
          onClick={onNavigate}
          className="mt-2.5 inline-flex h-8 items-center rounded-lg border border-line bg-paper px-2.5 text-xs font-medium hover:border-ink-faint"
        >
          Show on map
        </Link>
      ) : null}
    </div>
  );
}

function Question({ text }: { text: string }) {
  return (
    <div className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-tr-sm bg-board px-3.5 py-2.5 text-sm text-amber-soft">{text}</div>
  );
}

function Conversation({ turns, tripId, onNavigate }: { turns: AssistantTurn[]; tripId: string; onNavigate: () => void }) {
  return (
    <>
      {turns.map((t, i) =>
        t.role === "user" ? <Question key={i} text={t.text} /> : <Answer key={i} turn={t} tripId={tripId} onNavigate={onNavigate} />,
      )}
    </>
  );
}

interface Pending {
  question: string;
  text: string;
  tools: string[];
}

export default function AssistantPanel({ tripId, onClose }: { tripId: string; onClose: () => void }) {
  const ready = useAuth().status === "signedIn";
  const qc = useQueryClient();
  const thread = useQuery({
    queryKey: threadKey(tripId),
    queryFn: () => api<AssistantThread>(`/trips/${tripId}/assistant`),
    enabled: ready,
  });
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [clearing, setClearing] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    panel.current?.focus();
    // Closing the panel stops an answer that is still streaming.
    return () => abort.current?.abort();
  }, []);

  const turns = thread.data?.turns ?? [];
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [turns.length, pending?.text, pending?.tools.length]);

  const ask = useCallback(
    async (message: string) => {
      const question = message.trim();
      if (!question || pending) return;
      setError(null);
      setDraft("");
      setPending({ question, text: "", tools: [] });
      const controller = new AbortController();
      abort.current = controller;
      try {
        await streamAnswer(tripId, question, controller.signal, (event) => {
          if (event.type === "text") setPending((p) => (p ? { ...p, text: p.text + event.text } : p));
          else if (event.type === "tool") setPending((p) => (p ? { ...p, tools: [...p.tools, event.label] } : p));
          else if (event.type === "done") {
            qc.setQueryData<AssistantThread>(threadKey(tripId), (old) =>
              old
                ? { ...old, usedToday: event.usedToday, turns: [...old.turns, { role: "user", text: question, at: event.turn.at }, event.turn] }
                : old,
            );
          }
        });
      } catch (e) {
        if (!controller.signal.aborted) {
          setError(e);
          setDraft(question);
        }
        // A stopped or failed answer may still have been saved; show what the server kept.
        void qc.invalidateQueries({ queryKey: threadKey(tripId) });
      } finally {
        abort.current = null;
        setPending(null);
        input.current?.focus();
      }
    },
    [pending, qc, tripId],
  );

  const clear = async () => {
    setClearing(true);
    setError(null);
    try {
      await api(`/trips/${tripId}/assistant`, { method: "DELETE" });
      qc.setQueryData<AssistantThread>(threadKey(tripId), (old) => (old ? { ...old, turns: [] } : old));
    } catch (e) {
      setError(e);
    } finally {
      setClearing(false);
    }
  };

  const data = thread.data;
  const canAsk = Boolean(data?.enabled);
  const left = data ? Math.max(data.dailyLimit - data.usedToday, 0) : null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Ask about this trip">
      <button className="absolute inset-0 hidden bg-board/40 sm:block" aria-label="Close the assistant" onClick={onClose} />
      <div
        ref={panel}
        tabIndex={-1}
        className="relative flex h-[100dvh] w-full flex-col bg-paper shadow-2xl focus:outline-none sm:max-w-md"
        data-testid="assistant-panel"
      >
        <div className="bg-board px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] text-amber-soft">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="font-mono text-[11px] uppercase tracking-[0.25em] text-amber-soft/60">Trip assistant</div>
              <h2 className="mt-1 text-xl font-semibold text-amber">Ask the trip</h2>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {canAsk && turns.length ? (
                <button
                  onClick={() => void clear()}
                  disabled={clearing || Boolean(pending)}
                  className="rounded px-2 py-1 text-xs text-amber-soft/80 hover:bg-board-3 hover:text-amber disabled:opacity-50"
                >
                  Clear
                </button>
              ) : null}
              <button onClick={onClose} className="rounded p-1.5 hover:bg-board-3" aria-label="Close">
                <XIcon />
              </button>
            </div>
          </div>
          <p className="mt-1.5 text-xs text-amber-soft/70">
            Answers come from the trip plan, with a web search when the plan doesn&apos;t know. It can read the plan but not change it.
          </p>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto overscroll-contain p-4" aria-live="polite">
          {thread.isPending ? <Spinner /> : null}
          {thread.error ? <ErrorNote error={thread.error} /> : null}

          {data?.reason === "demo" ? (
            <>
              <div className="rounded-xl border border-line bg-card px-3.5 py-3 text-sm" data-testid="assistant-off">
                Asking is off for the demo account, so public visitors don&apos;t run up a bill. Here&apos;s a recorded example of what it does.
              </div>
              <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink-faint">Example conversation</div>
              <Conversation turns={DEMO_TURNS} tripId={tripId} onNavigate={onClose} />
            </>
          ) : null}

          {data?.reason === "off" ? (
            <div className="rounded-xl border border-line bg-card px-3.5 py-3 text-sm" data-testid="assistant-off">
              The trip assistant is turned off on this deployment. Everything else works as usual.
            </div>
          ) : null}

          {canAsk ? (
            <>
              {turns.length === 0 && !pending ? (
                <div className="space-y-2">
                  <p className="text-sm text-ink-soft">Try one of these, or ask your own question.</p>
                  <div className="flex flex-col items-start gap-1.5">
                    {ASSISTANT_SUGGESTIONS.map((s) => (
                      <button
                        key={s}
                        onClick={() => void ask(s)}
                        disabled={left === 0}
                        className="rounded-full border border-line bg-card px-3 py-1.5 text-left text-sm hover:border-ink-faint disabled:opacity-50"
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              <Conversation turns={turns} tripId={tripId} onNavigate={onClose} />
              {pending ? (
                <>
                  <Question text={pending.question} />
                  <div className="rounded-2xl rounded-tl-sm border border-line bg-card px-3.5 py-3 text-sm">
                    <ToolLines tools={pending.tools} />
                    {pending.text ? (
                      <div className="whitespace-pre-wrap leading-relaxed">{pending.text}</div>
                    ) : (
                      <Spinner label={pending.tools.length ? "Thinking it through" : "Reading the trip"} />
                    )}
                  </div>
                </>
              ) : null}
            </>
          ) : null}
          {error ? <ErrorNote error={error} /> : null}
          <div ref={bottom} />
        </div>

        {canAsk ? (
          <form
            className="border-t border-line bg-card p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
            onSubmit={(e) => {
              e.preventDefault();
              void ask(draft);
            }}
          >
            <div className="flex items-end gap-2">
              <label htmlFor="assistant-question" className="sr-only">
                Your question
              </label>
              <textarea
                id="assistant-question"
                ref={input}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void ask(draft);
                  }
                }}
                rows={2}
                maxLength={ASSISTANT_MAX_MESSAGE}
                placeholder="Ask about the trip…"
                disabled={Boolean(pending) || left === 0}
                className="min-h-[2.75rem] flex-1 resize-none rounded-lg border border-line bg-paper px-3 py-2 text-base sm:text-sm"
              />
              {pending ? (
                <Button onClick={() => abort.current?.abort()}>Stop</Button>
              ) : (
                <Button type="submit" variant="primary" disabled={!draft.trim() || left === 0}>
                  Ask
                </Button>
              )}
            </div>
            {data ? (
              <p className="mt-1.5 text-[11px] text-ink-faint">
                {left === 0 ? "That's today's limit of questions. Ask again tomorrow." : `${left} of ${data.dailyLimit} questions left today.`}
              </p>
            ) : null}
          </form>
        ) : null}
      </div>
    </div>
  );
}
