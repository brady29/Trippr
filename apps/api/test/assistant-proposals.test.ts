import type { AssistantProposal, AssistantProposalResult, AssistantThread, AssistantTurn, LibraryActivity, RouteView } from "@trippr/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createScriptedModel, type ScriptStep } from "../src/services/assistant/fake";
import type { ModelRequest } from "../src/services/assistant/model";
import type { LookupInput, LookupResult, PlaceLookup } from "../src/services/inbox/lookup";
import type { GeoResult, Geocoder } from "../src/services/places/geocoder";
import { client, signIn, startHarness, type Harness } from "./harness";

const TRIP = "asia-2027";
const MAIN = "route-main";

/** The fake model answers from this queue; each entry sees the request it answers. */
let steps: ((request: ModelRequest) => ScriptStep)[] = [];
const model = createScriptedModel((request) => (steps.shift() ?? (() => ({ text: "Done." })))(request));

/** Stands in for the Feature 4 place lookup (Claude with web search): answers by title. */
const answers = new Map<string, LookupResult>();
const lookups: LookupInput[] = [];
const fakeLookup: PlaceLookup = {
  name: "fake",
  async lookup(input) {
    lookups.push(input);
    return answers.get(input.title) ?? null;
  },
};

/** Stands in for OpenStreetMap. */
const points = new Map<string, GeoResult>();
const fakeGeocoder: Geocoder = { name: "fake-proposals", search: async (query) => points.get(query.text) ?? null };

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

function toolResults(request: ModelRequest): { content: string; is_error?: boolean }[] {
  const last = request.messages.at(-1);
  if (!last || last.role !== "user" || typeof last.content === "string") return [];
  return last.content.filter((b) => b.type === "tool_result") as { content: string; is_error?: boolean }[];
}

type Api = ReturnType<typeof client>;

let h: Harness;
let owner: Awaited<ReturnType<typeof signIn>>;
let editor: Awaited<ReturnType<typeof signIn>>;
let viewer: Awaited<ReturnType<typeof signIn>>;

const route = async (api: Api = owner.api) => (await api.get<RouteView>(`/routes/${MAIN}`)).body;
const stopIn = (view: RouteView, code: string) => view.stops.find((s) => s.city.code === code)!;

/**
 * Asks a question; the model calls propose_changes once with `proposals`,
 * then answers. Returns the finished turn and what the tool told the model.
 */
async function propose(api: Api, proposals: unknown[], message = "Can you change the plan?") {
  let result: { content: string; is_error?: boolean } | undefined;
  steps = [
    () => ({ toolCalls: [{ name: "propose_changes", input: { proposals } }] }),
    (request) => {
      result = toolResults(request)[0];
      return { text: "Here's what I'd suggest." };
    },
  ];
  const res = await api.post(`/trips/${TRIP}/assistant`, { message });
  expect(res.status).toBe(200);
  const events = parseEvents(res.text);
  const done = events.at(-1)!;
  expect(done.event).toBe("done");
  return { turn: done.data.turn as AssistantTurn, result: result!, events };
}

const apply = (api: Api, id: string) => api.post<AssistantProposalResult>(`/trips/${TRIP}/assistant/proposals/${id}/apply`);
const dismiss = (api: Api, id: string) => api.post<AssistantProposalResult>(`/trips/${TRIP}/assistant/proposals/${id}/dismiss`);

describe("assistant suggested changes", () => {
  beforeAll(async () => {
    h = await startHarness({
      assistantModel: model,
      placeLookup: fakeLookup,
      geocoder: fakeGeocoder,
      env: { INBOX_LOOKUP: "on", ASSISTANT_DAILY_LIMIT: "100" },
    });
    owner = await signIn(h.app, "Proposals Owner");
    editor = await signIn(h.app, "Proposals Editor");
    viewer = await signIn(h.app, "Proposals Viewer");
    await owner.api.post(`/invites/${h.ownerInvite}/accept`);
    const asEditor = await owner.api.post(`/trips/${TRIP}/invites`, { role: "editor" });
    await editor.api.post(`/invites/${asEditor.body.token}/accept`);
    const asViewer = await owner.api.post(`/trips/${TRIP}/invites`, { role: "viewer" });
    await viewer.api.post(`/invites/${asViewer.body.token}/accept`);
  });

  afterAll(async () => {
    await h?.close();
  });

  beforeEach(() => {
    steps = [];
  });

  it("offers propose_changes to editors and owners, never to viewers", async () => {
    const names = () => model.requests.at(-1)!.tools.map((t) => ("name" in t ? t.name : ""));
    steps = [() => ({ text: "Hi." })];
    await editor.api.post(`/trips/${TRIP}/assistant`, { message: "Hello?" });
    expect(names()).toContain("propose_changes");
    expect(names().at(-1)).toBe("web_search");
    expect(model.requests.at(-1)!.system[0]!.text).toContain("propose_changes");

    steps = [() => ({ text: "Hi." })];
    await viewer.api.post(`/trips/${TRIP}/assistant`, { message: "Hello?" });
    expect(names()).not.toContain("propose_changes");

    // A viewer's model that calls it anyway gets an error and no cards.
    let result: { content: string; is_error?: boolean } | undefined;
    steps = [
      () => ({ toolCalls: [{ name: "propose_changes", input: { proposals: [{ kind: "set_nights", stopId: "x", nights: 9 }] } }] }),
      (request) => {
        result = toolResults(request)[0];
        return { text: "I can't change that." };
      },
    ];
    const res = await viewer.api.post(`/trips/${TRIP}/assistant`, { message: "Make Tokyo 9 nights" });
    expect(result).toMatchObject({ is_error: true, content: "There is no tool called propose_changes." });
    expect(parseEvents(res.text).at(-1)!.data.turn.proposals).toBeUndefined();

    expect((await viewer.api.get<AssistantThread>(`/trips/${TRIP}/assistant`)).body.canPropose).toBe(false);
    expect((await editor.api.get<AssistantThread>(`/trips/${TRIP}/assistant`)).body.canPropose).toBe(true);
  });

  it("stores open suggestions on the answer, against the route version, and writes nothing", async () => {
    const before = await route();
    const tokyo = stopIn(before, "TYO");
    const { turn, result, events } = await propose(editor.api, [{ kind: "set_nights", stopId: tokyo.id, nights: tokyo.nights + 1 }]);
    expect(events.some((e) => e.event === "tool" && e.data.label === "Preparing suggested changes…")).toBe(true);
    expect(turn.proposals).toHaveLength(1);
    const [p] = turn.proposals!;
    expect(p).toMatchObject({
      kind: "set_nights",
      routeId: MAIN,
      version: before.route.version,
      status: "open",
      summary: `Tokyo: ${tokyo.nights} → ${tokyo.nights + 1} nights`,
      change: { kind: "set_nights", stopId: tokyo.id, nights: tokyo.nights + 1 },
    });
    expect(JSON.parse(result.content)).toMatchObject({ suggested: [{ id: p!.id, summary: p!.summary }] });
    // Nothing changed yet.
    expect((await route()).route.version).toBe(before.route.version);
    expect(stopIn(await route(), "TYO").nights).toBe(tokyo.nights);

    // It survives a reload, and the model hears about it on the next question.
    const thread = (await editor.api.get<AssistantThread>(`/trips/${TRIP}/assistant`)).body;
    expect(thread.turns.at(-1)!.proposals![0]!.id).toBe(p!.id);
    steps = [() => ({ text: "Ok." })];
    await editor.api.post(`/trips/${TRIP}/assistant`, { message: "Thanks" });
    const history = model.requests.at(-1)!.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    expect(history).toContain(`[Suggested changes: "${p!.summary}" (open)]`);

    // Applying it goes through PATCH /stops/:id as the editor.
    const res = await apply(editor.api, p!.id);
    expect(res.status).toBe(200);
    expect(res.body.proposal).toMatchObject({ id: p!.id, status: "applied", target: { kind: "route", routeId: MAIN } });
    const after = await route();
    expect(stopIn(after, "TYO").nights).toBe(tokyo.nights + 1);
    expect(after.route.version).toBeGreaterThan(before.route.version);
    // Applying twice changes nothing more.
    expect((await apply(editor.api, p!.id)).body.proposal.status).toBe("applied");
    expect(stopIn(await route(), "TYO").nights).toBe(tokyo.nights + 1);
  });

  it("applies each kind through the normal API, and applying one keeps its siblings open", async () => {
    const before = await route();
    const tokyo = stopIn(before, "TYO");
    const xian = stopIn(before, "SIA");
    const stops = before.stops.length;
    const { turn } = await propose(owner.api, [
      { kind: "plan_activity", stopId: tokyo.id, activityId: "act-teamlab", day: 2, startTime: "10:00", durationMin: 120 },
      { kind: "add_stop", cityCode: "OSA", afterStopId: tokyo.id, nights: 2 },
      { kind: "add_leg", stopId: xian.id, mode: "hsr", from: { hubId: "stn-beijing-west" }, to: { cityCode: "SIA" }, number: "G99", departAt: `${xian.arrive}T09:00+08:00` },
      { kind: "set_nights", stopId: xian.id, nights: xian.nights + 1 },
    ]);
    expect(turn.proposals!.map((p) => p.kind)).toEqual(["plan_activity", "add_stop", "add_leg", "set_nights"]);
    const [plan, addStop, addLeg, nights] = turn.proposals!;
    expect(plan!.summary).toMatch(/^Plan teamLab Planets on Day \d+ \(.+\) at 10:00 for 120 min$/);
    expect(addStop!.summary).toBe("Add Osaka for 2 nights after Tokyo");
    expect(addLeg!.summary).toMatch(/^Add a high-speed train idea to Xi'an: Beijing West → Xi'an North \(G99, /);
    expect(addLeg!.change).toMatchObject({ from: { kind: "station", id: "stn-beijing-west" }, to: { kind: "station", id: "stn-xian-north" } });

    const planned = await apply(owner.api, plan!.id);
    expect(planned.body.proposal).toMatchObject({ status: "applied", target: { kind: "itinerary", routeId: MAIN } });
    expect(stopIn(await route(), "TYO").planned.find((a) => a.id === "act-teamlab")).toMatchObject({ day: 2, startTime: "10:00", durationMin: 120 });

    expect((await apply(owner.api, addStop!.id)).body.proposal.status).toBe("applied");
    let view = await route();
    expect(view.stops).toHaveLength(stops + 1);
    expect(view.stops[tokyo.order + 1]!.city.code).toBe("OSA");
    expect(view.stops[tokyo.order + 1]!.nights).toBe(2);

    // The route moved on, but only by this member's own applied suggestion: the rest still apply.
    const leg = await apply(owner.api, addLeg!.id);
    expect(leg.status).toBe(200);
    view = await route();
    expect(stopIn(view, "SIA").legs.find((l) => l.number === "G99")).toMatchObject({ status: "idea", mode: "hsr" });

    expect((await apply(owner.api, nights!.id)).status).toBe(200);
    expect(stopIn(await route(), "SIA").nights).toBe(xian.nights + 1);

    const thread = (await owner.api.get<AssistantThread>(`/trips/${TRIP}/assistant`)).body;
    expect(thread.turns.at(-1)!.proposals!.map((p) => p.status)).toEqual(["applied", "applied", "applied", "applied"]);
  });

  it("goes stale when the route changes before Apply, with a friendly 409", async () => {
    const view = await route();
    const beijing = stopIn(view, "BJS");
    const { turn } = await propose(editor.api, [{ kind: "set_nights", stopId: beijing.id, nights: beijing.nights + 2 }]);
    const p = turn.proposals![0]!;

    // Someone else edits the route by hand.
    expect((await owner.api.patch(`/stops/${beijing.id}`, { notes: "Moved things around", version: view.route.version })).status).toBe(200);

    const res = await apply(editor.api, p.id);
    expect(res.status).toBe(409);
    expect((res.body as any).error).toMatchObject({ code: "version_conflict", message: "The plan changed; ask again." });
    expect(stopIn(await route(), "BJS").nights).toBe(beijing.nights);
    const stored = (await editor.api.get<AssistantThread>(`/trips/${TRIP}/assistant`)).body.turns.at(-1)!.proposals![0]!;
    expect(stored).toMatchObject({ id: p.id, status: "stale", note: "The plan changed; ask again." });
  });

  it("shows a suggestion as stale on reload once its route has changed", async () => {
    const view = await route();
    const hongKong = stopIn(view, "HKG");
    const { turn } = await propose(editor.api, [{ kind: "set_nights", stopId: hongKong.id, nights: hongKong.nights + 1 }]);
    expect((await owner.api.patch(`/stops/${hongKong.id}`, { notes: "Changed", version: view.route.version })).status).toBe(200);
    const thread = (await editor.api.get<AssistantThread>(`/trips/${TRIP}/assistant`)).body;
    const stored = thread.turns.flatMap((t) => t.proposals ?? []).find((p) => p.id === turn.proposals![0]!.id)!;
    expect(stored.status).toBe("stale");
  });

  it("dismisses a suggestion, which then can't be applied", async () => {
    const view = await route();
    const canton = stopIn(view, "CAN");
    const { turn } = await propose(editor.api, [{ kind: "set_nights", stopId: canton.id, nights: canton.nights + 1 }]);
    const p = turn.proposals![0]!;
    const res = await dismiss(editor.api, p.id);
    expect(res.status).toBe(200);
    expect(res.body.proposal).toMatchObject({ id: p.id, status: "dismissed" });
    expect((await apply(editor.api, p.id)).status).toBe(400);
    expect(stopIn(await route(), "CAN").nights).toBe(canton.nights);
    expect((await dismiss(editor.api, "prop_unknown")).status).toBe(404);
  });

  it("drops suggestions with unknown or mismatched ids, telling the model why", async () => {
    const view = await route();
    const tokyo = stopIn(view, "TYO");
    const chongqing = stopIn(view, "CKG");
    const { turn, result } = await propose(editor.api, [
      { kind: "set_nights", stopId: "stop-made-up", nights: 3 },
      { kind: "plan_activity", stopId: chongqing.id, activityId: "act-teamlab" },
      { kind: "plan_activity", stopId: tokyo.id, activityId: "act-made-up" },
      { kind: "add_stop", cityCode: "ZZZ", nights: 2 },
      { kind: "set_nights", stopId: chongqing.id, nights: chongqing.nights + 1 },
    ]);
    expect(turn.proposals!.map((p) => p.change)).toEqual([{ kind: "set_nights", stopId: chongqing.id, nights: chongqing.nights + 1 }]);
    const body = JSON.parse(result.content) as { dropped: { n: number; reason: string }[] };
    expect(body.dropped.map((d) => d.n)).toEqual([1, 2, 3, 4]);
    expect(body.dropped[0]!.reason).toMatch(/no stop stop-made-up/);
    expect(body.dropped[1]!.reason).toMatch(/is in Tokyo, but stop .* is Chongqing/);
    expect(body.dropped[2]!.reason).toMatch(/no activity act-made-up/);
    expect(body.dropped[3]!.reason).toMatch(/no city ZZZ/);
  });

  it("finds the place behind a new idea: links, and a pin when the lookup is confident", async () => {
    answers.set("Shibuya Sky", {
      placeName: "SHIBUYA SKY",
      address: "2-24-12 Shibuya, Shibuya City, Tokyo",
      cityCode: "TYO",
      website: "https://www.shibuya-scramble-square.com/sky/",
      ticketUrl: "https://www.shibuya-scramble-square.com/sky/ticket/",
      reserveUrl: null,
      eventDate: null,
      confidence: "high",
      evidence: ["Official site."],
      seenUrls: ["https://www.shibuya-scramble-square.com/sky/", "https://www.shibuya-scramble-square.com/sky/ticket/"],
    });
    points.set("SHIBUYA SKY, 2-24-12 Shibuya, Shibuya City, Tokyo", {
      lat: 35.6585,
      lon: 139.7023,
      address: "SHIBUYA SKY, Shibuya Scramble Square, Shibuya, Tokyo, Japan",
      osmId: "way/77",
    });
    const { turn } = await propose(editor.api, [{ kind: "add_activity", cityCode: "TYO", title: "Shibuya Sky", tags: ["view"], note: "Best at sunset." }], "Add Shibuya Sky as an idea");
    expect(lookups.at(-1)).toMatchObject({ kind: "activity", title: "Shibuya Sky", city: { code: "TYO" } });
    const p = turn.proposals![0]!;
    expect(p).toMatchObject({
      kind: "add_activity",
      routeId: null,
      version: null,
      summary: `Add "Shibuya Sky" to Tokyo's ideas`,
      detail: "Found website, tickets; pin on the map.",
      change: { place: { placeStatus: "placed", website: "https://www.shibuya-scramble-square.com/sky/" } },
    });
    // Still only a suggestion.
    expect((await owner.api.get<LibraryActivity[]>(`/trips/${TRIP}/activities`)).body.some((a) => a.title === "Shibuya Sky")).toBe(false);

    const res = await apply(editor.api, p.id);
    expect(res.status).toBe(200);
    const added = (await owner.api.get<LibraryActivity[]>(`/trips/${TRIP}/activities`)).body.find((a) => a.title === "Shibuya Sky")!;
    expect(added).toMatchObject({
      cityCode: "TYO",
      tags: ["view"],
      website: "https://www.shibuya-scramble-square.com/sky/",
      ticketUrl: "https://www.shibuya-scramble-square.com/sky/ticket/",
      lat: 35.6585,
      lon: 139.7023,
      placeStatus: "placed",
    });
    expect(res.body.proposal).toMatchObject({ status: "applied", target: { kind: "map", focus: [`act:${added.id}`] } });
    const comments = (await owner.api.get<{ text: string }[]>(`/activities/${added.id}/comments`)).body;
    expect(comments.map((c) => c.text)).toContain("Best at sunset.");

    // Now it exists, suggesting it again is dropped as a duplicate.
    const again = await propose(editor.api, [{ kind: "add_activity", cityCode: "TYO", title: "shibuya sky" }]);
    expect(again.turn.proposals).toBeUndefined();
    expect(again.result.content).toMatch(/already an idea in Tokyo/);
  });

  it("adds a new idea with just the given fields when the lookup finds nothing", async () => {
    const { turn } = await propose(editor.api, [{ kind: "add_activity", cityCode: "OSA", title: "Unknown little bar" }]);
    const p = turn.proposals![0]!;
    expect(p.detail ?? null).toBeNull();
    expect((await apply(editor.api, p.id)).status).toBe(200);
    const added = (await owner.api.get<LibraryActivity[]>(`/trips/${TRIP}/activities`)).body.find((a) => a.title === "Unknown little bar")!;
    expect(added).toMatchObject({ cityCode: "OSA", placeStatus: "unplaced" });
    expect(added.website ?? null).toBeNull();
  });

  it("refuses Apply and Dismiss for viewers, strangers, the demo account and other members", async () => {
    const view = await route();
    const shenzhen = stopIn(view, "SZX");
    const { turn } = await propose(editor.api, [{ kind: "set_nights", stopId: shenzhen.id, nights: shenzhen.nights + 1 }]);
    const p: AssistantProposal = turn.proposals![0]!;

    expect((await apply(viewer.api, p.id)).status).toBe(403);
    expect((await dismiss(viewer.api, p.id)).status).toBe(403);

    const stranger = await signIn(h.app, "Proposals Stranger");
    expect((await apply(stranger.api, p.id)).status).toBe(404);

    const demo = client(h.app, (await client(h.app).post("/auth/demo")).body.token);
    const res = await apply(demo, p.id);
    expect(res.status).toBe(403);
    expect((res.body as any).error.message).toMatch(/read-only/);

    // Threads are private: the owner can't apply the editor's suggestion.
    expect((await apply(owner.api, p.id)).status).toBe(404);
    expect((await apply(client(h.app), p.id)).status).toBe(401);

    // None of that changed anything; the editor still can.
    expect(stopIn(await route(), "SZX").nights).toBe(shenzhen.nights);
    expect((await apply(editor.api, p.id)).status).toBe(200);
    expect(stopIn(await route(), "SZX").nights).toBe(shenzhen.nights + 1);
  });
});
