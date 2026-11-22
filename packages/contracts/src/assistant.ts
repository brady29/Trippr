import { z } from "zod";
import type { HubRef, LegMode } from "./explorer";
import type { FoundPlace } from "./inbox";

/**
 * The trip assistant: members ask questions about the trip in plain words and
 * get answers grounded in the trip graph (read-only in this version).
 */

export const ASSISTANT_MAX_MESSAGE = 2000;

export const assistantAskBody = z.object({
  message: z.string().trim().min(1, "Ask a question").max(ASSISTANT_MAX_MESSAGE, `Keep questions under ${ASSISTANT_MAX_MESSAGE} characters`),
});
export type AssistantAskBody = z.infer<typeof assistantAskBody>;

/** Things in the trip an answer is about; they render as chips and filter the map. */
export interface AssistantRefs {
  stopIds: string[];
  activityIds: string[];
  legIds: string[];
  hotelIds: string[];
  cityCodes: string[];
}

export const emptyRefs = (): AssistantRefs => ({ stopIds: [], activityIds: [], legIds: [], hotelIds: [], cityCodes: [] });

/** A web page an answer quoted, from the web search tool. */
export interface AssistantCitation {
  url: string;
  title: string | null;
  citedText?: string | null;
}

/** A labelled reference chip: what the id is, in words. */
export interface AssistantRefLabel {
  kind: "stop" | "activity" | "leg" | "hotel" | "city";
  id: string;
  label: string;
}

export interface AssistantTurn {
  role: "user" | "assistant";
  text: string;
  at: string;
  /** Assistant turns: what the answer is about, the tools it used, the web pages it cited. */
  refs?: AssistantRefs;
  labels?: AssistantRefLabel[];
  citations?: AssistantCitation[];
  tools?: string[];
  /** Set when the answer stopped early (cut off, declined, or failed). */
  error?: string | null;
  /** Editors and owners only: changes the assistant suggested, each applied or dismissed by hand. */
  proposals?: AssistantProposal[];
}

/** GET /trips/:id/assistant: my thread on this trip, and whether I can ask. */
export interface AssistantThread {
  enabled: boolean;
  /** Why asking is off: the demo account, or the assistant is switched off here. */
  reason: "demo" | "off" | null;
  dailyLimit: number;
  usedToday: number;
  turns: AssistantTurn[];
  /** Whether this member may get and apply suggested changes (editors and owners, never the demo). */
  canPropose?: boolean;
}

/** Server-sent events from POST /trips/:id/assistant, one JSON object per `data:` line. */
export type AssistantEvent =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; label: string }
  | { type: "done"; turn: AssistantTurn; usedToday: number }
  | { type: "error"; message: string };

export const ASSISTANT_SUGGESTIONS = [
  "What's still unbooked?",
  "Which days are free?",
  "Is there a train from Chengdu to Chongqing?",
  "What's near our Tokyo hotel?",
] as const;

/** Map node ids for "Show on map": act:<id>, stop:<id>, leg:<id>, hotel:<id>, city:<code>. */
export function assistantFocusIds(refs: AssistantRefs): string[] {
  return [
    ...refs.stopIds.map((id) => `stop:${id}`),
    ...refs.activityIds.map((id) => `act:${id}`),
    ...refs.legIds.map((id) => `leg:${id}`),
    ...refs.hotelIds.map((id) => `hotel:${id}`),
    ...refs.cityCodes.map((code) => `city:${code}`),
  ];
}

export const hasRefs = (refs: AssistantRefs | undefined | null): refs is AssistantRefs =>
  Boolean(refs && (refs.stopIds.length || refs.activityIds.length || refs.legIds.length || refs.hotelIds.length || refs.cityCodes.length));

// --- suggested changes (editors) ---------------------------------------------

/** At most this many suggested changes per answer. */
export const ASSISTANT_MAX_PROPOSALS = 5;

export const ASSISTANT_PROPOSAL_KINDS = ["add_activity", "plan_activity", "set_nights", "add_stop", "add_leg"] as const;
export type AssistantProposalKind = (typeof ASSISTANT_PROPOSAL_KINDS)[number];

/**
 * open: waiting for Apply or Dismiss; applied / dismissed: done; stale: the
 * route changed after it was suggested, so it must be asked for again;
 * failed: Apply ran and the API refused it (the note says why).
 */
export type AssistantProposalStatus = "open" | "applied" | "dismissed" | "stale" | "failed";

/** Exactly what Apply sends through the normal API, checked when it was suggested. */
export type AssistantChange =
  | {
      kind: "add_activity";
      cityCode: string;
      title: string;
      tags: string[];
      note: string | null;
      url: string | null;
      /** What the place lookup found (links, and a pin only when it was confident). */
      place?: FoundPlace | null;
    }
  | { kind: "plan_activity"; stopId: string; activityId: string; day?: number; startTime?: string; durationMin?: number }
  | { kind: "set_nights"; stopId: string; nights: number }
  | { kind: "add_stop"; cityCode: string; afterStopId: string | null; nights: number }
  | {
      kind: "add_leg";
      stopId: string;
      mode: LegMode;
      from: HubRef;
      to: HubRef;
      operator: string | null;
      number: string | null;
      departAt: string | null;
      arriveAt: string | null;
      status: "idea";
    };

/** Where to look at an applied change. */
export type AssistantProposalTarget =
  | { kind: "route"; routeId: string }
  | { kind: "itinerary"; routeId: string }
  | { kind: "map"; focus: string[] };

export interface AssistantProposal {
  id: string;
  kind: AssistantProposalKind;
  /** The route and route version it was suggested against; null for library-only changes (new activity ideas). */
  routeId: string | null;
  version: number | null;
  /** What will change, in words: "Tokyo: 4 → 5 nights". */
  summary: string;
  /** A second line, such as the links the place lookup found. */
  detail?: string | null;
  status: AssistantProposalStatus;
  /** Why it failed or went stale, or what applying did. */
  note?: string | null;
  change: AssistantChange;
  /** Set once applied: where the change can be seen. */
  target?: AssistantProposalTarget | null;
  appliedAt?: string | null;
}

/** POST /trips/:id/assistant/proposals/:proposalId/apply and .../dismiss. */
export interface AssistantProposalResult {
  proposal: AssistantProposal;
}

/** What Apply says when the route changed after the suggestion was made. */
export const PROPOSAL_STALE_MESSAGE = "The plan changed; ask again.";
