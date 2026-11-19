import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app";

const HEARTBEAT_MS = 25_000;
/** Streams end after this long; the browser reconnects if the tab is still in use. */
const MAX_STREAM_MS = 10 * 60_000;

export function liveRoutes(app: FastifyInstance, ctx: AppContext) {
  const { guards, repos, live, config } = ctx;
  const allowed = new Set(config.WEB_ORIGIN.split(",").map((o) => o.trim()));

  /**
   * Server-sent events for one trip: `presence` (who is here) and `change`
   * (what someone else just saved). Authenticated with the normal bearer
   * header; the browser reads it with fetch(), so no token goes in the URL.
   */
  app.get("/trips/:id/live", async (req, reply) => {
    const user = ctx.user(req);
    const { id } = ctx.parse(z.object({ id: z.string().min(1) }), req.params);
    await guards.trip(user, id, "viewer");
    const members = await repos.trips.members(id);
    const name = members.find((m) => m.id === user.id)?.name ?? user.name ?? "Traveller";

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
    res.write(`retry: 5000\n\n`);

    let closed = false;
    const disconnect = live.connect(id, { id: user.id, name }, {
      write: (chunk) => {
        if (!closed) res.write(chunk);
      },
      end: () => finish(),
    });
    const heartbeat = setInterval(() => res.write(`: ping\n\n`), HEARTBEAT_MS);
    const limit = setTimeout(() => finish(), MAX_STREAM_MS);

    function finish() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      clearTimeout(limit);
      disconnect();
      res.end();
    }
    req.raw.on("close", finish);
  });
}
