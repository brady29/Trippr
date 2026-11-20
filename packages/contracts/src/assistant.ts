import { z } from "zod";

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
}

/** GET /trips/:id/assistant: my thread on this trip, and whether I can ask. */
export interface AssistantThread {
  enabled: boolean;
  /** Why asking is off: the demo account, or the assistant is switched off here. */
  reason: "demo" | "off" | null;
  dailyLimit: number;
  usedToday: number;
  turns: AssistantTurn[];
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
