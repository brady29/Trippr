/**
 * Builds src/dev/graph-fixture.json: a GraphJSON for the seeded Asia 2027
 * trip, used only for local development (?fixture=1 or
 * NEXT_PUBLIC_GRAPH_FIXTURE=1 with `next dev`) before the backend's
 * /trips/:id/graph endpoint exists. Never used in production.
 *
 * Hubs and legs for the Main route follow the spec's hub table (approximate
 * coordinates, marked "verify" there). Areas are the spec's suggestions;
 * the two hotels are obvious examples.
 *
 *   node apps/web/scripts/build-graph-fixture.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const seedDir = resolve(here, "../../../seed");
const read = (f) => JSON.parse(readFileSync(resolve(seedDir, f), "utf8"));

const countries = read("countries.json");
const cities = read("cities.json");
const activities = read("activities.json");
const trip = read("trip.json");
const routes = trip.routes.map(read);

const TAGS = ["sport", "tech", "nature", "culture", "food"];
const primary = (tags) => TAGS.find((t) => tags?.includes(t)) ?? "other";
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

const nodes = new Map();
const edges = [];
const add = (n) => {
  if (!nodes.has(n.id)) nodes.set(n.id, n);
  return nodes.get(n.id);
};
const link = (type, source, target, attrs) => edges.push({ id: `${type}:${source}->${target}`, type, source, target, ...(attrs ? { attrs } : {}) });

const countryOf = new Map(cities.map((c) => [c.code, c.country]));
const colorOf = new Map(countries.map((k) => [k.iso, k.color]));
const cityByCode = new Map(cities.map((c) => [c.code, c]));

const tripId = `trip:${trip.id}`;
add({ id: tripId, type: "trip", label: trip.name, attrs: { startDate: trip.startDate, homeCity: trip.homeCity }, style: {} });

const usedCities = new Set();
const addCity = (code) => {
  const c = cityByCode.get(code);
  usedCities.add(code);
  const iso = countryOf.get(code);
  const k = countries.find((x) => x.iso === iso);
  add({ id: `country:${iso}`, type: "country", label: k.name, attrs: { iso }, style: { color: k.color } });
  const node = add({
    id: `city:${code}`,
    type: "city",
    label: c.name,
    lat: c.lat,
    lon: c.lon,
    cityCode: code,
    attrs: { code, countryIso: iso },
    style: { color: colorOf.get(iso), routes: [] },
  });
  if (!edges.some((e) => e.id === `IN:city:${code}->country:${iso}`)) link("IN", `city:${code}`, `country:${iso}`);
  return node;
};

// Hubs from the spec's table (Main route only, plus Shanghai).
const HUBS = {
  airports: {
    HND: ["Tokyo Haneda", 35.55, 139.78, "TYO"],
    PEK: ["Beijing Capital", 40.08, 116.58, "BJS"],
    HKG: ["Hong Kong International", 22.31, 113.91, "HKG"],
    HAN: ["Hanoi Noi Bai", 21.22, 105.81, "HAN"],
    SGN: ["Ho Chi Minh City Tan Son Nhat", 10.82, 106.66, "SGN"],
    LBJ: ["Komodo Airport, Labuan Bajo", -8.49, 119.89, "KOM"],
    DPS: ["Bali Ngurah Rai", -8.75, 115.17, "DPS"],
    PVG: ["Shanghai Pudong", 31.14, 121.81, "SHA"],
  },
  stations: {
    "stn-beijing-west": ["Beijing West", 39.89, 116.32, "BJS"],
    "stn-xian-north": ["Xi'an North", 34.38, 108.94, "SIA"],
    "stn-chongqing-west": ["Chongqing West", 29.5, 106.43, "CKG"],
    "stn-guangzhou-south": ["Guangzhou South", 22.99, 113.27, "CAN"],
    "stn-shenzhen-north": ["Shenzhen North", 22.61, 114.03, "SZX"],
    "stn-futian": ["Futian", 22.54, 114.06, "SZX"],
    "stn-west-kowloon": ["Hong Kong West Kowloon", 22.3, 114.17, "HKG"],
    "stn-shanghai-hongqiao": ["Shanghai Hongqiao", 31.19, 121.32, "SHA"],
  },
};
const hubNode = (kind, id) => {
  const [name, lat, lon, city] = kind === "airport" ? HUBS.airports[id] : HUBS.stations[id];
  const nodeId = kind === "airport" ? `apt:${id}` : `stn:${id}`;
  if (!nodes.has(nodeId)) {
    addCity(city);
    add({ id: nodeId, type: kind, label: name, lat, lon, cityCode: city, attrs: { code: kind === "airport" ? id : null, verify: true }, style: { routes: [] } });
    link("SERVES", nodeId, `city:${city}`);
  }
  return nodes.get(nodeId);
};
// Default hub per city and mode (spec: "a default hub per city and mode").
const DEFAULT_HUB = {
  TYO: { flight: ["airport", "HND"] },
  BJS: { flight: ["airport", "PEK"], rail: ["station", "stn-beijing-west"] },
  SIA: { rail: ["station", "stn-xian-north"] },
  CKG: { rail: ["station", "stn-chongqing-west"] },
  CAN: { rail: ["station", "stn-guangzhou-south"] },
  SZX: { rail: ["station", "stn-futian"] },
  HKG: { rail: ["station", "stn-west-kowloon"], flight: ["airport", "HKG"] },
  HAN: { flight: ["airport", "HAN"] },
  SGN: { flight: ["airport", "SGN"] },
  KOM: { flight: ["airport", "LBJ"] },
  DPS: { flight: ["airport", "DPS"] },
};
const railish = (m) => m === "hsr" || m === "train" || m === "maglev";

const plannedBy = new Map(); // activity id -> route ids
for (const route of routes) {
  const rId = `route:${route.id}`;
  add({ id: rId, type: "route", label: route.name, attrs: { tags: route.tags, isCurrent: route.isCurrent }, style: { routes: [route.id] } });
  link("HAS_ROUTE", tripId, rId);
  const short = route.id.replace(/^route-/, "");
  let cursor = trip.startDate;
  let prev = null;
  route.stops.forEach((s, i) => {
    const city = addCity(s.city);
    city.style.routes = [...new Set([...(city.style.routes ?? []), route.id])];
    const sId = `stop:stop-${short}-${String(i + 1).padStart(2, "0")}`;
    const arrive = cursor;
    const depart = addDays(arrive, s.nights);
    cursor = depart;
    add({
      id: sId,
      type: "stop",
      label: `${i + 1}. ${city.label}`,
      lat: city.lat,
      lon: city.lon,
      cityCode: s.city,
      attrs: { order: i, nights: s.nights, routeId: route.id, routeName: route.name, arriveMode: s.arriveMode ?? "flight" },
      style: { routes: [route.id] },
    });
    link("HAS_STOP", rId, sId, { order: i });
    link("AT", sId, `city:${s.city}`);
    if (prev) link("NEXT", prev.id, sId);
    for (const a of s.plans ?? []) {
      plannedBy.set(a, [...(plannedBy.get(a) ?? []), { route: route.id, stop: sId }]);
    }
    // Legs: Main route only, between consecutive stops.
    if (route.id === "route-main" && prev) {
      const mode = s.arriveMode ?? "flight";
      const want = railish(mode) ? "rail" : "flight";
      const fromDef = DEFAULT_HUB[prev.cityCode]?.[want] ?? DEFAULT_HUB[prev.cityCode]?.flight ?? DEFAULT_HUB[prev.cityCode]?.rail;
      const toDef = DEFAULT_HUB[s.city]?.[want] ?? DEFAULT_HUB[s.city]?.flight ?? DEFAULT_HUB[s.city]?.rail;
      if (fromDef && toDef) {
        const from = hubNode(...fromDef);
        const to = hubNode(...toDef);
        from.style.routes = [...new Set([...(from.style.routes ?? []), route.id])];
        to.style.routes = [...new Set([...(to.style.routes ?? []), route.id])];
        const lId = `leg:lg-${short}-${String(i + 1).padStart(2, "0")}`;
        const status = i === 1 ? "booked" : i === 2 ? "held" : "idea";
        add({
          id: lId,
          type: "leg",
          label: `${from.attrs.code ?? from.label.split(" ")[0]} → ${to.attrs.code ?? to.label.split(" ")[0]}`,
          attrs: { mode, seq: 0, status, stopId: sId, routeId: route.id, departAt: null, arriveAt: null, operator: null, number: null, priceCad: null, from: from.id, to: to.id },
          style: { mode, status, routes: [route.id] },
        });
        link("ARRIVES_VIA", sId, lId, { seq: 0 });
        link("FROM", lId, from.id);
        link("TO", lId, to.id);
      }
    }
    prev = nodes.get(sId);
  });
}

for (const a of activities) {
  if (!usedCities.has(a.city)) continue;
  const plans = plannedBy.get(a.id) ?? [];
  const id = `act:${a.id}`;
  add({
    id,
    type: "activity",
    label: a.title,
    cityCode: a.city,
    attrs: { when: a.when ?? null, costCad: a.costCad ?? null, tags: a.tags ?? [] },
    style: {
      tag: primary(a.tags),
      tags: a.tags ?? [],
      planned: plans.length > 0,
      fixedDate: Boolean(a.when),
      votes: a.id === "act-liziba" ? 3 : a.id === "act-npb" ? 2 : 0,
      routes: [...new Set(plans.map((p) => p.route))],
    },
  });
  link("IN", id, `city:${a.city}`);
  for (const p of plans) link("PLANS", p.stop, id);
}

// Areas from the spec's suggestions (approximate centres), and two example hotels.
const AREAS = [
  ["TYO", "Shibuya", 35.659, 139.7, ["nightlife", "transit"]],
  ["TYO", "Asakusa", 35.714, 139.796, ["culture", "quiet"]],
  ["BJS", "Dongcheng hutongs (Gulou)", 39.94, 116.394, ["culture"]],
  ["SIA", "Bell Tower / Muslim Quarter", 34.261, 108.943, ["central", "food"]],
  ["CKG", "Jiefangbei / Yuzhong", 29.557, 106.577, ["central", "nightlife"]],
  ["HKG", "Sheung Wan", 22.286, 114.15, ["food", "culture"]],
  ["HAN", "Old Quarter / Hoan Kiem", 21.029, 105.852, ["food", "central"]],
  ["DPS", "Canggu", -8.65, 115.13, ["beach", "food"]],
  ["DPS", "Ubud", -8.507, 115.263, ["culture", "quiet"]],
];
for (const [city, name, lat, lon, vibes] of AREAS) {
  const id = `area:${city.toLowerCase()}-${name.toLowerCase().replace(/[^a-z]+/g, "-").replace(/-$/, "")}`;
  add({ id, type: "area", label: name, lat, lon, cityCode: city, attrs: { vibes }, style: { votes: 0 } });
  link("IN", id, `city:${city}`);
}
const HOTELS = [
  ["hotel:example-shibuya", "Example hotel (Shibuya)", "area:tyo-shibuya", "TYO", 35.6585, 139.701, 180, "stop:stop-main-01", "chosen"],
  ["hotel:example-sheung-wan", "Example hotel (Sheung Wan)", "area:hkg-sheung-wan", "HKG", 22.2865, 114.151, 150, "stop:stop-main-07", "shortlist"],
];
for (const [id, label, area, city, lat, lon, price, stop, status] of HOTELS) {
  add({ id, type: "hotel", label, lat, lon, cityCode: city, attrs: { priceCadPerNight: price, priceBasis: "room", sleeps: 2, example: true }, style: { status, routes: ["route-main"] } });
  link("IN", id, area);
  link("STAYS_AT", stop, id, { status });
}

const list = [...nodes.values()];
const counts = {};
for (const n of list) counts[n.type] = (counts[n.type] ?? 0) + 1;

const graph = {
  nodes: list,
  edges,
  meta: {
    tripId: trip.id,
    scope: "trip",
    routeId: null,
    city: null,
    truncated: false,
    counts,
    generatedAt: new Date().toISOString(),
    routes: routes.map((r) => ({ id: r.id, name: r.name, isCurrent: Boolean(r.isCurrent) })),
    tripStart: trip.startDate,
  },
};

const out = resolve(here, "../src/dev/graph-fixture.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(graph, null, 1)}\n`);
console.log(`wrote ${out}: ${list.length} nodes, ${edges.length} edges`, counts);
