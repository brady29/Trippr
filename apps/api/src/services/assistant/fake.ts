import type Anthropic from "@anthropic-ai/sdk";
import type { AssistantCitation } from "@trippr/contracts";
import type { AssistantModel, ModelRequest } from "./model";

/** One scripted model response. */
export interface ScriptStep {
  /** Answer text, streamed in a few chunks (may end with <refs>{...}</refs>). */
  text?: string;
  toolCalls?: { name: string; input: unknown }[];
  /** Pretends the server ran a web search that returned these pages. */
  webSearch?: AssistantCitation[];
  stopReason?: Anthropic.Beta.BetaStopReason;
}

export type Script = ScriptStep[] | ((request: ModelRequest, index: number) => ScriptStep);

export interface ScriptedModel extends AssistantModel {
  /** Every request the assistant made, copied at the time. */
  requests: ModelRequest[];
}

/**
 * A model with no network: replies come from a script, so tests exercise the
 * real tool loop, the API calls made as the asking member, streaming and
 * thread storage. Once an array script runs out it answers "Done.".
 */
export function createScriptedModel(script: Script): ScriptedModel {
  const requests: ModelRequest[] = [];
  let toolId = 0;
  return {
    name: "scripted",
    requests,
    async turn(request, emit, signal) {
      const index = requests.length;
      requests.push(structuredClone(request));
      const step = typeof script === "function" ? script(request, index) : (script[index] ?? { text: "Done." });
      const content: Anthropic.Beta.BetaContentBlock[] = [];
      for (const page of step.webSearch ?? []) {
        emit({ type: "server_tool", name: "web_search" });
        emit({ type: "citation", citation: page });
      }
      if (step.text) {
        // Odd-sized chunks, so markers get split across deltas as they do for real.
        for (let i = 0; i < step.text.length; i += 7) {
          if (signal.aborted) throw new Error("aborted");
          emit({ type: "text", text: step.text.slice(i, i + 7) });
        }
        content.push({ type: "text", text: step.text, citations: null });
      }
      for (const call of step.toolCalls ?? []) {
        content.push({ type: "tool_use", id: `toolu_fake_${++toolId}`, name: call.name, input: call.input });
      }
      return { content, stopReason: step.stopReason ?? (step.toolCalls?.length ? "tool_use" : "end_turn") };
    },
  };
}
