import type { GraphJSON, GraphNode } from "@trippr/contracts";
import { buildItinerary, type ItineraryStopInput } from "@trippr/rules";
import { describe, expect, it } from "vitest";
import { TAG_COLOR } from "./graph-palette";
import {
  activityFromNode,
  boundsOf,
  buildMapItems,
  dayOptions,
  dayScope,
  describeItem,
  inBounds,
  layerOf,
  MAP_LAYERS,
  MAX_FEATURES,
  parseFocus,
  resolveFocus,
  routeSegments,
  shapeOf,
  toFeatureCollections,
  type MapLayer,
  type RouteStopLike,
} from "./map-features";

const node = (n: Partial<GraphNode> & Pick<GraphNode, "id" | "type">): GraphNode => ({ label: n.id, attrs: {}, style: {}, ...n });

const stops: RouteStopLike[] = [
  { id: "s_1", arriveMode: "flight", city: { code: "TYO", name: "Tokyo", lat: 35.68, lon: 139.69 } },
  { id: "s_2", arriveMode: "flight", city: { code: "CKG", name: "Chongqing", lat: 29.56, lon: 106.55 } },
  { id: "s_3", arriveMode: "hsr", city: { code: "CTU", name: "Chengdu", lat: 30.66, lon: 104.07 } },
];

const graph: GraphJSON = {
  nodes: [
    node({ id: "city:CKG", type: "city", label: "Chongqing", lat: 29.56, lon: 106.55, cityCode: "CKG" }),
    node({ id: "stop:s_2", type: "stop", label: "2. Chongqing", lat: 29.56, lon: 106.55, cityCode: "CKG" }),
    node({
      id: "act:act-liziba",
      type: "activity",
      label: "Liziba station",
      lat: 29.5536,
      lon: 106.5418,
      cityCode: "CKG",
      attrs: { placeStatus: "manual", countryIso: "CN", website: "https://example.com", tags: ["tech", "culture"], commentCount: 2 },
      style: { tag: "tech", tags: ["tech", "culture"], planned: true, votes: 2 },
    }),
    node({ id: "act:act-hotpot", type: "activity", label: "Chongqing hotpot", lat: 29.56, lon: 106.57, cityCode: "CKG", style: { tags: ["food"], votes: 4 } }),
    node({ id: "act:act-game", type: "activity", label: "Baseball game", lat: 35.7, lon: 139.75, cityCode: "TYO", style: { tags: ["sport"], fixedDate: true, planned: true } }),
    node({ id: "act:act-unplaced", type: "activity", label: "Somewhere", cityCode: "CKG", style: { tags: ["nature"] } }),
    node({ id: "hotel:h_1", type: "hotel", label: "Booked hotel", lat: 29.55, lon: 106.58, cityCode: "CKG", style: { status: "booked" } }),
    node({ id: "hotel:h_2", type: "hotel", label: "Maybe hotel", lat: 29.54, lon: 106.59, cityCode: "CKG", style: { status: "shortlist" } }),
    node({ id: "area:a_1", type: "area", label: "Jiefangbei", lat: 29.557, lon: 106.577, cityCode: "CKG" }),
    node({ id: "stn:stn-ckg-north", type: "station", label: "Chongqing North", lat: 29.61, lon: 106.55, cityCode: "CKG" }),
    node({ id: "stn:stn-ctu-east", type: "station", label: "Chengdu East", lat: 30.63, lon: 104.14, cityCode: "CTU" }),
    node({ id: "apt:HND", type: "airport", label: "Haneda (HND)", lat: 35.55, lon: 139.78, cityCode: "TYO" }),
    node({
      id: "leg:lg_3",
      type: "leg",
      label: "High-speed train",
      cityCode: "CTU",
      attrs: { stopId: "s_3", from: "stn:stn-ckg-north", to: "stn:stn-ctu-east", departAt: "2027-05-10T09:00+08:00" },
      style: { mode: "hsr" },
    }),
  ],
  edges: [{ id: "STAYS_AT:stop:s_2->hotel:h_1", type: "STAYS_AT", source: "stop:s_2", target: "hotel:h_1", attrs: { status: "booked" } }],
  meta: { tripId: "t", scope: "route", routeId: "r", truncated: false, counts: {}, generatedAt: "", routes: [], tripStart: "2027-05-01" },
};

const all = new Set<MapLayer>(MAP_LAYERS);

describe("map layers and shapes", () => {
  it("puts each node type under one toggle with its own shape", () => {
    const by = (id: string) => graph.nodes.find((n) => n.id === id)!;
    expect([layerOf(by("act:act-liziba")), shapeOf(by("act:act-liziba"))]).toEqual(["planned", "circle"]);
    expect([layerOf(by("act:act-hotpot")), shapeOf(by("act:act-hotpot"))]).toEqual(["ideas", "ring"]);
    expect([layerOf(by("act:act-game")), shapeOf(by("act:act-game"))]).toEqual(["events", "diamond"]);
    expect(shapeOf(by("hotel:h_1"))).toBe("square");
    expect(shapeOf(by("hotel:h_2"))).toBe("square-outline");
    expect(shapeOf(by("stn:stn-ckg-north"))).toBe("triangle");
    expect(shapeOf(by("apt:HND"))).toBe("plane");
    expect(layerOf(by("area:a_1"))).toBe("areas");
    expect(layerOf(by("leg:lg_3"))).toBeNull();
    expect(layerOf(by("city:CKG"))).toBeNull();
  });
});

describe("buildMapItems", () => {
  it("draws placed things, counts unplaced activities and adds route stops", () => {
    const { items, unplaced, truncated } = buildMapItems(graph, stops, { layers: all });
    expect(unplaced).toBe(1);
    expect(truncated).toBe(false);
    expect(items.find((i) => i.id === "act:act-unplaced")).toBeUndefined();
    expect(items.filter((i) => i.type === "stop").map((i) => i.label)).toEqual(["1. Tokyo", "2. Chongqing", "3. Chengdu"]);
    // Graph stop nodes aren't duplicated: stops come from the route.
    expect(items.filter((i) => i.id === "stop:s_2")).toHaveLength(1);
    const liziba = items.find((i) => i.id === "act:act-liziba")!;
    expect(liziba.color).toBe(TAG_COLOR.tech);
    expect(liziba.cityName).toBe("Chongqing");
  });

  it("lists things in route order, each stop before its city's places", () => {
    const { items } = buildMapItems(graph, stops, { layers: all });
    const ids = items.map((i) => i.id);
    expect(ids[0]).toBe("stop:s_1");
    expect(ids.indexOf("stop:s_2")).toBeLessThan(ids.indexOf("act:act-liziba"));
    expect(ids.indexOf("act:act-game")).toBeLessThan(ids.indexOf("stop:s_2"));
    expect(ids.indexOf("stn:stn-ctu-east")).toBeGreaterThan(ids.indexOf("stop:s_3"));
  });

  it("sizes ideas by votes", () => {
    const { items } = buildMapItems(graph, stops, { layers: all });
    expect(items.find((i) => i.id === "act:act-hotpot")!.radius).toBeGreaterThan(7);
  });

  it("honours the layer toggles", () => {
    const { items } = buildMapItems(graph, stops, { layers: new Set<MapLayer>(["hotels"]) });
    expect(items.map((i) => i.id).sort()).toEqual(["hotel:h_1", "hotel:h_2"]);
  });

  it("searches labels and city names", () => {
    expect(buildMapItems(graph, stops, { layers: all, search: "hotpot" }).items.map((i) => i.id)).toEqual(["act:act-hotpot"]);
    const chengdu = buildMapItems(graph, stops, { layers: all, search: "CHENGDU" }).items.map((i) => i.id);
    expect(chengdu).toEqual(expect.arrayContaining(["stop:s_3", "stn:stn-ctu-east"]));
  });

  it("keeps under the feature limit, favouring planned things", () => {
    const many: GraphNode[] = Array.from({ length: MAX_FEATURES + 50 }, (_, i) =>
      node({ id: `act:x${i}`, type: "activity", label: `Idea ${i}`, lat: 30, lon: 106, cityCode: "CKG", style: { votes: 0 } }),
    );
    const g = { ...graph, nodes: [...graph.nodes, ...many] };
    const { items, truncated } = buildMapItems(g, stops, { layers: all });
    expect(truncated).toBe(true);
    expect(items).toHaveLength(MAX_FEATURES);
    expect(items.some((i) => i.id === "act:act-liziba")).toBe(true);
    expect(items.some((i) => i.id === "stop:s_1")).toBe(true);
  });
});

describe("focus", () => {
  it("parses ids, dropping junk and duplicates", () => {
    expect(parseFocus(" act:act-liziba,stop:s_1,,act:act-liziba, nonsense ,hotel:h_2")).toEqual(["act:act-liziba", "stop:s_1", "hotel:h_2"]);
    expect(parseFocus(null)).toEqual([]);
    expect(parseFocus("<script>")).toEqual([]);
  });

  it("resolves stops, places and legs, and ignores unknown or unplaced ids", () => {
    const f = resolveFocus(["act:act-liziba", "stop:s_1", "leg:lg_3", "act:nope", "act:act-unplaced"], graph, stops);
    expect(f.found).toBe(3);
    expect([...f.nodeIds].sort()).toEqual(["act:act-liziba", "stn:stn-ckg-north", "stn:stn-ctu-east"]);
    expect([...f.stopIds]).toEqual(["s_1"]);
    expect([...f.segmentStopIds]).toEqual(["s_3"]);
    expect(f.points).toHaveLength(4);
  });

  it("narrows the items to the focused ones and flags them", () => {
    const focus = resolveFocus(["act:act-liziba", "stop:s_1"], graph, stops);
    const { items } = buildMapItems(graph, stops, { layers: all, focus });
    expect(items.map((i) => i.id)).toEqual(["stop:s_1", "act:act-liziba"]);
    expect(items.every((i) => i.focused)).toBe(true);
  });

  it("shows everything when nothing in the focus could be found", () => {
    const focus = resolveFocus(["act:gone"], graph, stops);
    expect(focus.found).toBe(0);
    expect(buildMapItems(graph, stops, { layers: all, focus }).items.length).toBe(buildMapItems(graph, stops, { layers: all }).items.length);
  });
});

describe("day filter", () => {
  const input: ItineraryStopInput[] = [
    { id: "s_1", nights: 2, arrive: "2027-05-01", depart: "2027-05-03", arriveMode: "flight", city: { code: "TYO", name: "Tokyo" }, planned: [], legs: [], stays: [] },
    {
      id: "s_2",
      nights: 7,
      arrive: "2027-05-03",
      depart: "2027-05-10",
      arriveMode: "flight",
      city: { code: "CKG", name: "Chongqing" },
      planned: [{ id: "act-liziba", title: "Liziba station", day: 2 }],
      legs: [],
      stays: [],
    },
    {
      id: "s_3",
      nights: 2,
      arrive: "2027-05-10",
      depart: "2027-05-12",
      arriveMode: "hsr",
      city: { code: "CTU", name: "Chengdu" },
      planned: [],
      legs: [{ id: "lg_3", mode: "hsr", from: { name: "Chongqing North" }, to: { name: "Chengdu East" }, departAt: "2027-05-10T09:00+08:00" }],
      stays: [],
    },
  ];
  const itinerary = buildItinerary(input);

  it("labels days with their city", () => {
    expect(dayOptions(itinerary)[3]).toEqual({ date: "2027-05-04", label: "Day 4 · Chongqing" });
    expect(dayOptions(null)).toEqual([]);
  });

  it("keeps a day's stop, planned activities and hotel", () => {
    const day = dayScope(itinerary, "2027-05-04", graph)!;
    expect([...day.stopIds]).toEqual(["s_2"]);
    expect(day.travelStopIds.size).toBe(0);
    expect(day.nodeIds.has("act:act-liziba")).toBe(true);
    expect(day.nodeIds.has("hotel:h_1")).toBe(true);
    const ids = buildMapItems(graph, stops, { layers: all, day }).items.map((i) => i.id);
    expect(ids).toEqual(["stop:s_2", "act:act-liziba", "hotel:h_1"]);
  });

  it("shows a travel day's legs, their hubs and both ends of the journey", () => {
    const day = dayScope(itinerary, "2027-05-10", graph)!;
    expect([...day.travelStopIds]).toEqual(["s_3"]);
    expect([...day.stopIds].sort()).toEqual(["s_2", "s_3"]);
    expect(day.nodeIds.has("leg:lg_3")).toBe(true);
    expect(day.nodeIds.has("stn:stn-ckg-north")).toBe(true);
    const lines = routeSegments(stops, { only: day.travelStopIds });
    expect(lines.features).toHaveLength(1);
    expect(lines.features[0]!.properties).toMatchObject({ kind: "rail", stopId: "s_3" });
  });

  it("is null for a date off the route", () => {
    expect(dayScope(itinerary, "2030-01-01", graph)).toBeNull();
  });
});

describe("geometry", () => {
  it("draws flights as arcs and rail as straight lines, highlighting focused legs", () => {
    const fc = routeSegments(stops, { highlight: new Set(["s_3"]) });
    expect(fc.features).toHaveLength(2);
    const [flight, rail] = fc.features as GeoJSON.Feature<GeoJSON.LineString>[];
    expect(flight!.properties).toMatchObject({ kind: "flight", focus: 0 });
    expect(flight!.geometry.coordinates.length).toBeGreaterThan(2);
    expect(rail!.properties).toMatchObject({ kind: "rail", focus: 1 });
    expect(rail!.geometry.coordinates).toHaveLength(2);
  });

  it("splits activities from other places and leaves stops to the markers", () => {
    const { items } = buildMapItems(graph, stops, { layers: all });
    const { activities, places } = toFeatureCollections(items);
    expect(activities.features.every((f) => f.properties?.type === "activity")).toBe(true);
    expect(activities.features).toHaveLength(3);
    expect(places.features.map((f) => f.properties?.type)).not.toContain("stop");
  });

  it("frames points and checks bounds, across the date line too", () => {
    expect(boundsOf([])).toBeNull();
    expect(boundsOf([[106, 29], [139, 35]])).toEqual([[106, 29], [139, 35]]);
    expect(inBounds([120, 30], [[100, 20], [140, 40]])).toBe(true);
    expect(inBounds([90, 30], [[100, 20], [140, 40]])).toBe(false);
    expect(inBounds([-175, 0], [[170, -10], [-170, 10]])).toBe(true);
  });
});

describe("activityFromNode", () => {
  it("rebuilds the activity for link chips and the pin editor", () => {
    const a = activityFromNode(graph.nodes.find((n) => n.id === "act:act-liziba")!, "Chongqing");
    expect(a).toMatchObject({
      id: "act-liziba",
      title: "Liziba station",
      cityCode: "CKG",
      cityName: "Chongqing",
      countryIso: "CN",
      website: "https://example.com",
      lat: 29.5536,
      lon: 106.5418,
      placeStatus: "manual",
      votes: 2,
      commentCount: 2,
    });
  });

  it("describes items for screen readers", () => {
    const { items } = buildMapItems(graph, stops, { layers: all });
    expect(describeItem(items.find((i) => i.id === "act:act-hotpot")!)).toBe("Chongqing hotpot, Activity idea, Chongqing, food, 4 votes");
    expect(describeItem(items.find((i) => i.id === "stop:s_2")!)).toBe("2. Chongqing, route stop");
  });
});
