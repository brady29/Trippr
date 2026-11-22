import {
  assistantAskBody,
  PROPOSAL_STALE_MESSAGE,
  type AssistantEvent,
  type AssistantProposalResult,
  type AssistantThread,
} from "@trippr/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app";
import { AppError } from "../errors";
import { createClaudeAssistantModel, type AssistantModel } from "../services/assistant/model";
import { createAssistant } from "../services/assistant/service";

const idParams = z.object({ id: z.string().min(1) });
const proposalParams = z.object({ id: z.string().min(1), proposalId: z.string().min(1).max(80) });
const HEARTBEAT_MS = 15_000;
/** The demo account is read-only; this is what it sees instead of the generic message. */
const DEMO_MESSAGE = "Asking the assistant is off for the demo account, so public visitors don't run up a bill. Here's an example conversation instead.";
const DEMO_PROPOSAL_MESSAGE = "The demo account is read-only, so it can't apply suggested changes.";

export function assistantRoutes(app: FastifyInstance, ctx: AppContext, options: { model?: AssistantModel } = {}) {
  const { config, guards } = ctx;
  const model =
    options.model ?? (config.ANTHROPIC_API_KEY ? createClaudeAssistantModel({ apiKey: config.ANTHROPIC_API_KEY, model: config.ASSISTANT_MODEL }) : null);
  const assistant = createAssistant(ctx, model);
  const allowed = new Set(config.WEB_ORIGIN.split(",").map((o) => o.trim()));

  /** My thread on this trip, and whether I can ask. */
  app.get("/trips/:id/assistant", async (req): Promise<AssistantThread> => {
    const user = ctx.user(req);
    const { id } = ctx.parse(idParams, req.params);
    const { role } = await guards.trip(user, id, "viewer");
    return assistant.thread(user, id, role);
  });

  /**
   * Apply one of my suggested changes: the normal API request(s), made as me.
   * If the route changed since it was suggested, it becomes stale and this
   * answers 409 with "The plan changed; ask again."
   */
  app.post(
    "/trips/:id/assistant/proposals/:proposalId/apply",
    { config: { demoMessage: DEMO_PROPOSAL_MESSAGE } },
    async (req): Promise<AssistantProposalResult> => {
      const user = ctx.user(req);
      const { id, proposalId } = ctx.parse(proposalParams, req.params);
      await guards.trip(user, id, "editor");
      const proposal = await assistant.applyProposal(user, id, proposalId);
      if (proposal.status === "stale") throw new AppError(409, "version_conflict", proposal.note ?? PROPOSAL_STALE_MESSAGE, { proposal });
      return { proposal };
    },
  );

  /** Dismiss one of my suggested changes. */
  app.post(
    "/trips/:id/assistant/proposals/:proposalId/dismiss",
    { config: { demoMessage: DEMO_PROPOSAL_MESSAGE } },
    async (req): Promise<AssistantProposalResult> => {
      const user = ctx.user(req);
      const { id, proposalId } = ctx.parse(proposalParams, req.params);
      await guards.trip(user, id, "editor");
      return { proposal: await assistant.dismissProposal(user, id, proposalId) };
    },
  );

  /** Clears my thread (today's question count stays). */
  app.delete("/trips/:id/assistant", { config: { demoMessage: DEMO_MESSAGE } }, async (req, reply) => {
    const user = ctx.user(req);
    const { id } = ctx.parse(idParams, req.params);
    await guards.trip(user, id, "viewer");
    await assistant.clear(user, id);
    reply.status(204);
  });

  /**
   * Ask a question. Answers stream as server-sent events (see AssistantEvent):
   * `text` deltas, `tool` activity lines, then `done` with the stored turn
   * (references, citations) or `error`.
   */
  app.post("/trips/:id/assistant", { config: { demoMessage: DEMO_MESSAGE } }, async (req, reply) => {
    const user = ctx.user(req);
    const { id } = ctx.parse(idParams, req.params);
    const { message } = ctx.parse(assistantAskBody, req.body);
    if (!assistant.enabled) throw new AppError(503, "unavailable", "The trip assistant is turned off here.");
    const { role } = await guards.trip(user, id, "viewer");
    if ((await assistant.usedToday(user)) >= assistant.limit) {
      throw new AppError(
        429,
        "rate_limited",
        `You've asked ${assistant.limit} questions today, which is the daily limit. Ask again tomorrow.`,
      );
    }
    const prepared = await assistant.prepare(user, id);
    await assistant.count(user, id);

    const origin = req.headers.origin;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      ...(origin && allowed.has(origin) ? { "access-control-allow-origin": origin, vary: "Origin" } : {}),
    });
    const controller = new AbortController();
    // The browser closed the panel or lost the connection before the answer finished.
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    const send = (event: AssistantEvent) => {
      if (!res.writableEnded && !res.destroyed) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(`: ping\n\n`);
    }, HEARTBEAT_MS);
    try {
      await assistant.ask({ user, tripId: id, role, message, send, signal: controller.signal }, prepared);
    } catch (err) {
      req.log.error({ err }, "assistant failed");
      send({ type: "error", message: "Something went wrong while answering. Try again." });
    } finally {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    }
  });
}
