import type { AssistantThread, AssistantTurn, RouteView } from "@trippr/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createScriptedModel, type ScriptStep } from "../src/services/assistant/fake";
import type { ModelRequest } from "../src/services/assistant/model";
import { client, signIn, startHarness, type Harness } from "./harness";

const TRIP = "asia-2027";
const MAIN = "route-main";
const LIMIT = 6;

/** The fake model answers from this queue; each entry sees the request it answers. */
let steps: ((request: ModelRequest) => ScriptStep)[] = [];
const model = createScriptedModel((request) => (steps.shift() ?? (() => ({ text: "Done." })))(request));

type Event = { event: string; data: any };
function parseEvents(text: string): Event[] {
  return text
    .split("\n\n")
    .map((block) => {
      const event = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      return event && data ? { event, data: JSON.parse(data) } : null;
    })
    .filter((e): e is Event => e !== null);
}

/** The tool results sent back in a request, by tool_use id order. */
function toolResults(request: ModelRequest): { content: string; is_error?: boolean }[] {
  const last = request.messages.at(-1);
  if (!last || last.role !== "user" || typeof last.content === "string") return [];
  return last.content.filter((b) => b.type === "tool_result") as { content: string; is_error?: boolean }[];
}

let h: Harness;
let owner: Awaited<ReturnType<typeof signIn>>;
let viewer: Awaited<ReturnType<typeof signIn>>;
let sia: RouteView["stops"][number];

async function ask(api: ReturnType<typeof client>, message: string) {
  const res = await api.post(`/trips/${TRIP}/assistant`, { message });
  return { ...res, events: parseEvents(res.text) };
}

describe("trip assistant", () => {
  beforeAll(async () => {
    h = await startHarness({ assistantModel: model, env: { ASSISTANT_DAILY_LIMIT: String(LIMIT) } });
    owner = await signIn(h.app, "Assistant Owner");
    viewer = await signIn(h.app, "Assistant Viewer");
    await owner.api.post(`/invites/${h.ownerInvite}/accept`);
    const invite = await owner.api.post(`/trips/${TRIP}/invites`, { role: "viewer" });
    await viewer.api.post(`/invites/${invite.body.token}/accept`);

    // A booked train with a reference and seat only editors may see.
    const view = (await owner.api.get<RouteView>(`/routes/${MAIN}`)).body;
    sia = view.stops.find((s) => s.city.code === "SIA")!;
    const res = await owner.api.post<RouteView>(`/stops/${sia.id}/legs`, {
      mode: "hsr",
      from: { kind: "station", id: "stn-beijing-west" },
      to: { kind: "station", id: "stn-xian-north" },
      number: "G87",
      departAt: `${sia.arrive}T08:00+08:00`,
      status: "booked",
      bookingRef: "E12345678",
      seat: "07A",
      version: view.route.version,
    });
    expect(res.status).toBe(201);
  });

  afterAll(async () => {
    await h?.close();
  });

  beforeEach(() => {
    steps = [];
  });

  it("runs tools as the asking member, so a viewer's get_bookings has no booking references", async () => {
    let viewerResult = "";
    steps = [
      () => ({ toolCalls: [{ name: "get_bookings", input: {} }] }),
      (request) => {
        viewerResult = toolResults(request)[0]!.content;
        return { text: `Xi'an's train is booked; the hotel isn't.\n<refs>{"stopIds":["${sia.id}","stop-made-up"],"cityCodes":["SIA"]}</refs>` };
      },
    ];
    const res = await ask(viewer.api, "What's still unbooked?");
    expect(res.status).toBe(200);
    expect(String(res.headers["content-type"])).toContain("text/event-stream");
    expect(viewerResult).toContain("G87");
    expect(viewerResult).not.toContain("E12345678");
    expect(viewerResult).not.toContain("07A");
    expect(viewerResult).toContain('"canSeeBookingRefs":false');

    // The same tool as the owner does see them.
    let ownerResult = "";
    steps = [
      () => ({ toolCalls: [{ name: "get_bookings", input: {} }] }),
      (request) => {
        ownerResult = toolResults(request)[0]!.content;
        return { text: "Booked: G87." };
      },
    ];
    await ask(owner.api, "What's booked?");
    expect(ownerResult).toContain("E12345678");
    expect(ownerResult).toContain("07A");
  });

  it("streams text and tool activity, then a final event with checked references", async () => {
    steps = [
      () => ({ toolCalls: [{ name: "get_route", input: {} }] }),
      () => ({ text: `You arrive in Xi'an on ${sia.arrive}.\n<refs>{"stopIds":["${sia.id}","stop-made-up"],"activityIds":[],"legIds":[],"hotelIds":[],"cityCodes":["sia"]}</refs>` }),
    ];
    const res = await ask(viewer.api, "When do we get to Xi'an?");
    const kinds = res.events.map((e) => e.event);
    expect(kinds[0]).toBe("tool");
    expect(kinds.at(-1)).toBe("done");
    expect(res.events.find((e) => e.event === "tool")!.data).toEqual({ type: "tool", name: "get_route", label: "Looking at the route…" });

    const streamed = res.events.filter((e) => e.event === "text").map((e) => e.data.text).join("");
    expect(streamed).toBe(`You arrive in Xi'an on ${sia.arrive}.\n`);
    expect(streamed).not.toContain("<refs>");

    const done = res.events.at(-1)!.data as { turn: AssistantTurn; usedToday: number };
    expect(done.turn.text).toBe(`You arrive in Xi'an on ${sia.arrive}.`);
    expect(done.turn.refs).toEqual({ stopIds: [sia.id], activityIds: [], legIds: [], hotelIds: [], cityCodes: ["SIA"] });
    expect(done.turn.labels!.map((l) => l.kind)).toEqual(["stop", "city"]);
    expect(done.turn.tools).toEqual(["Looking at the route…"]);
    expect(done.usedToday).toBe(2);
  });

  it("asks with a cached system prompt and trip snapshot, the read tools, web search and a token cap", async () => {
    steps = [() => ({ text: "Hi." })];
    await ask(owner.api, "Hello?");
    const request = model.requests.at(-1)!;
    expect(request.maxTokens).toBe(4000);
    expect(request.system).toHaveLength(3);
    expect(request.system[1]!.cache_control).toEqual({ type: "ephemeral" });
    expect(request.system[1]!.text).toContain(`${sia.id} | ${sia.city.name} (SIA`);
    expect(request.system[1]!.text).toContain(`${MAIN} | `);
    expect(request.system[2]!.text).toContain("Assistant Owner");
    const names = request.tools.map((t) => ("name" in t ? t.name : ""));
    // The owner can edit, so it also gets propose_changes (see assistant-proposals.test.ts).
    expect(names).toEqual(["get_route", "get_itinerary", "search_activities", "get_bookings", "find_paths", "near", "compare_routes", "semantic_search", "propose_changes", "web_search"]);
    expect(request.tools.at(-1)).toEqual({ type: "web_search_20260209", name: "web_search", max_uses: 2 });
  });

  it("passes web citations through to the answer", async () => {
    steps = [
      () => ({
        webSearch: [
          { url: "https://example.com/visa", title: "China visa-free transit", citedText: "240 hours" },
          { url: "https://example.com/visa", title: "China visa-free transit" },
        ],
        text: "Visa-free transit is 240 hours.",
      }),
    ];
    const res = await ask(owner.api, "How long is visa-free transit in China?");
    expect(res.events.some((e) => e.event === "tool" && e.data.label === "Searching the web…")).toBe(true);
    const done = res.events.at(-1)!.data as { turn: AssistantTurn };
    expect(done.turn.citations).toEqual([{ url: "https://example.com/visa", title: "China visa-free transit", citedText: "240 hours" }]);
  });

  it("stops at 8 tool calls per question and asks for an answer", async () => {
    const before = model.requests.length;
    const busy = () => ({
      toolCalls: [
        { name: "get_route", input: {} },
        { name: "find_paths", input: { from: "CTU", to: "CKG", mode: "rail" } },
        { name: "get_itinerary", input: { from: "2027-05-01", to: "2027-05-31" } },
      ],
    });
    steps = [busy, busy, busy, () => ({ text: "Here's what I found." })];
    const res = await ask(owner.api, "Tell me everything.");
    expect(res.events.filter((e) => e.event === "tool")).toHaveLength(8);
    const requests = model.requests.slice(before);
    // Third round: two calls run, the third is refused; the next request turns tools off.
    expect(toolResults(requests[3]!).map((r) => Boolean(r.is_error))).toEqual([false, false, true]);
    expect(requests[3]!.toolChoice).toBe("none");
    expect(res.events.at(-1)!.data.turn.text).toBe("Here's what I found.");
  });

  it("reports bad tool input to the model instead of running it", async () => {
    let result: { content: string; is_error?: boolean } | undefined;
    steps = [
      () => ({ toolCalls: [{ name: "near", input: { lat: 35.7, lon: 139.7, km: 9000 } }] }),
      (request) => {
        result = toolResults(request)[0];
        return { text: "That radius is too big." };
      },
    ];
    await ask(owner.api, "What's within 9000 km?");
    expect(result?.is_error).toBe(true);
    expect(result?.content).toMatch(/Invalid input for near/);
  });

  it("keeps a private thread per member, sends earlier turns back, and clears it", async () => {
    const mine = (await viewer.api.get<AssistantThread>(`/trips/${TRIP}/assistant`)).body;
    expect(mine).toMatchObject({ enabled: true, reason: null, dailyLimit: LIMIT, usedToday: 2 });
    expect(mine.turns.map((t) => t.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(mine.turns[0]!.text).toBe("What's still unbooked?");
    const theirs = (await owner.api.get<AssistantThread>(`/trips/${TRIP}/assistant`)).body;
    expect(theirs.turns.some((t) => t.text === "What's still unbooked?")).toBe(false);

    steps = [() => ({ text: "Same answer as before." })];
    await ask(viewer.api, "And again?");
    const history = model.requests.at(-1)!.messages;
    expect(history[0]).toEqual({ role: "user", content: "What's still unbooked?" });
    expect(history.at(-1)).toEqual({ role: "user", content: "And again?" });

    expect((await viewer.api.del(`/trips/${TRIP}/assistant`)).status).toBe(204);
    const cleared = (await viewer.api.get<AssistantThread>(`/trips/${TRIP}/assistant`)).body;
    expect(cleared.turns).toEqual([]);
    // Clearing doesn't give questions back.
    expect(cleared.usedToday).toBe(3);
  });

  it("returns a friendly 429 once a member reaches the daily limit", async () => {
    const asker = await signIn(h.app, "Assistant Limit");
    const invite = await owner.api.post(`/trips/${TRIP}/invites`, { role: "editor" });
    await asker.api.post(`/invites/${invite.body.token}/accept`);
    for (let i = 0; i < LIMIT; i++) expect((await ask(asker.api, `Question ${i}`)).status).toBe(200);
    const res = await asker.api.post(`/trips/${TRIP}/assistant`, { message: "One more?" });
    expect(res.status).toBe(429);
    expect(res.body.error).toMatchObject({ code: "rate_limited" });
    expect(res.body.error.message).toContain("daily limit");
  });

  it("is off for the demo account, which gets a friendly 403", async () => {
    const demo = client(h.app, (await client(h.app).post("/auth/demo")).body.token);
    const res = await demo.post(`/trips/${TRIP}/assistant`, { message: "Hi" });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/off for the demo account/);
    expect((await demo.del(`/trips/${TRIP}/assistant`)).status).toBe(403);
    const thread = (await demo.get<AssistantThread>(`/trips/${TRIP}/assistant`)).body;
    expect(thread).toMatchObject({ enabled: false, reason: "demo", turns: [] });
  });

  it("refuses strangers and empty questions", async () => {
    const stranger = await signIn(h.app, "Assistant Stranger");
    expect((await stranger.api.post(`/trips/${TRIP}/assistant`, { message: "Hi" })).status).toBe(404);
    expect((await stranger.api.get(`/trips/${TRIP}/assistant`)).status).toBe(404);
    expect((await owner.api.post(`/trips/${TRIP}/assistant`, { message: "   " })).status).toBe(400);
    expect((await owner.api.post(`/trips/${TRIP}/assistant`, { message: "x".repeat(2001) })).status).toBe(400);
    expect((await client(h.app).post(`/trips/${TRIP}/assistant`, { message: "Hi" })).status).toBe(401);
  });
});

describe("trip assistant switched off", () => {
  let off: Harness;

  beforeAll(async () => {
    // The kill switch wins even when a model is available. Without a model
    // (no ANTHROPIC_API_KEY), the assistant is off the same way.
    off = await startHarness({ assistantModel: createScriptedModel([]), env: { ASSISTANT_ENABLED: "false" } });
  });

  afterAll(async () => {
    await off?.close();
  });

  it("answers 503 to questions and tells the panel it's off", async () => {
    const member = await signIn(off.app, "Off Owner");
    await member.api.post(`/invites/${off.ownerInvite}/accept`);
    const res = await member.api.post(`/trips/${TRIP}/assistant`, { message: "Hi" });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("unavailable");
    const thread = (await member.api.get<AssistantThread>(`/trips/${TRIP}/assistant`)).body;
    expect(thread).toMatchObject({ enabled: false, reason: "off" });
  });
});
