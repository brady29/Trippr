import Anthropic from "@anthropic-ai/sdk";
import type { AssistantCitation } from "@trippr/contracts";

/** What the model streams while it answers one request. */
export type ModelEvent =
  | { type: "text"; text: string }
  /** A server-side tool (web search) started. */
  | { type: "server_tool"; name: string }
  | { type: "citation"; citation: AssistantCitation };

export interface ModelRequest {
  system: Anthropic.Beta.BetaTextBlockParam[];
  tools: Anthropic.Beta.BetaToolUnion[];
  messages: Anthropic.Beta.BetaMessageParam[];
  maxTokens: number;
  /** "none" for the last request once the question's tool budget is spent. */
  toolChoice: "auto" | "none";
}

export interface ModelTurn {
  content: Anthropic.Beta.BetaContentBlock[];
  stopReason: Anthropic.Beta.BetaStopReason | null;
}

/**
 * One model request: stream it, report events, return the finished message.
 * The tool loop lives in the assistant service, so tests swap this for a
 * scripted fake and the real tools still run.
 */
export interface AssistantModel {
  name: string;
  turn(request: ModelRequest, emit: (event: ModelEvent) => void, signal: AbortSignal): Promise<ModelTurn>;
}

/** Claude through the official SDK: streamed, adaptive thinking, server-side refusal fallback. */
export function createClaudeAssistantModel(options: { apiKey: string; model: string }): AssistantModel {
  const client = new Anthropic({ apiKey: options.apiKey, timeout: 120_000, maxRetries: 1 });

  async function attempt(request: ModelRequest, emit: (event: ModelEvent) => void, signal: AbortSignal) {
    let emittedText = false;
    const stream = client.beta.messages.stream(
      {
        model: options.model,
        max_tokens: request.maxTokens,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        thinking: { type: "adaptive" },
        output_config: { effort: "medium" },
        // Caches the growing conversation between tool rounds; the system
        // prompt and trip snapshot carry their own breakpoint.
        cache_control: { type: "ephemeral" },
        system: request.system,
        tools: request.tools,
        tool_choice: { type: request.toolChoice },
        messages: request.messages,
      },
      { signal },
    );
    stream.on("text", (delta) => {
      emittedText = true;
      emit({ type: "text", text: delta });
    });
    stream.on("citation", (citation) => {
      if (citation.type === "web_search_result_location") {
        emit({ type: "citation", citation: { url: citation.url, title: citation.title, citedText: citation.cited_text } });
      }
    });
    stream.on("streamEvent", (event) => {
      if (event.type === "content_block_start" && event.content_block.type === "server_tool_use") {
        emit({ type: "server_tool", name: event.content_block.name });
      }
    });
    try {
      const message = await stream.finalMessage();
      return { content: message.content, stopReason: message.stop_reason };
    } catch (error) {
      throw Object.assign(error as object, { emittedText });
    }
  }

  return {
    name: "claude",
    async turn(request, emit, signal) {
      for (let tries = 0; ; tries++) {
        try {
          return await attempt(request, emit, signal);
        } catch (error) {
          // API errors (rate limits, overload, bad requests) and aborts are final.
          // Anything else is a dropped connection or a tool input the SDK could
          // not parse: re-issue once, unless part of the answer already went out.
          const emittedText = Boolean((error as { emittedText?: boolean }).emittedText);
          if (error instanceof Anthropic.APIError || signal.aborted || emittedText || tries >= 1) throw error;
        }
      }
    },
  };
}
