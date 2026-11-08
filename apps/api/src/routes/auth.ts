import { devLoginBody, updateMeBody, type AuthToken } from "@trippr/contracts";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app";
import { notFound } from "../errors";

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "user";

export function authRoutes(app: FastifyInstance, ctx: AppContext) {
  const { config, repos, auth } = ctx;

  /** Tells the web app which sign-in options this deployment offers. */
  app.get("/auth/config", async () => ({
    devLogin: config.AUTH_DEV_LOGIN,
    demo: Boolean(config.DEMO_TRIP_ID),
    external: auth.externalEnabled,
  }));

  /** Local development and CI only: sign in with just a name. */
  app.post("/auth/dev-login", async (req): Promise<AuthToken> => {
    if (!config.AUTH_DEV_LOGIN) throw notFound("Dev sign-in");
    const body = ctx.parse(devLoginBody, req.body);
    const id = `dev_${slug(body.email ?? body.name)}`;
    const user = await repos.users.upsert({ id, name: body.name, email: body.email ?? null });
    return { token: await auth.issue({ id, name: user.name, email: user.email }), user };
  });

  /** A read-only viewer account on the seeded trip, for the live demo. */
  app.post("/auth/demo", async (): Promise<AuthToken> => {
    const tripId = config.DEMO_TRIP_ID;
    if (!tripId || !(await repos.trips.get(tripId))) throw notFound("Demo");
    const id = "demo_viewer";
    const user = await repos.users.upsert({ id, name: "Demo viewer" });
    const existing = await repos.access.tripRole(tripId, id);
    if (!existing?.role) await repos.trips.setMemberRole(tripId, id, "viewer");
    const token = await auth.issue({ id, name: user.name, isDemo: true }, "1d");
    return { token, user: { ...user, isDemo: true } };
  });

  app.get("/me", async (req) => {
    const user = ctx.user(req);
    const me = await repos.users.upsert({ id: user.id });
    return { ...me, isDemo: user.isDemo };
  });

  /** Lets an external sign-in (whose token may carry no name) set a display name. */
  app.patch("/me", async (req) => {
    const user = ctx.user(req);
    const body = ctx.parse(updateMeBody, req.body);
    return repos.users.update(user.id, body);
  });
}
