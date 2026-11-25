// Checks seed/*.json for broken references: node seed/validate-seed.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const read = (f) => JSON.parse(readFileSync(join(dir, f), "utf8"));
const errors = [];
const fail = (msg) => errors.push(msg);
const unique = (items, key, label) => {
  const seen = new Set();
  for (const i of items) {
    if (seen.has(i[key])) fail(`duplicate ${label} ${i[key]}`);
    seen.add(i[key]);
  }
  return seen;
};

const countries = read("countries.json");
const cities = read("cities.json");
const activities = read("activities.json");
const { links } = read("links.json");
const hubs = read("hubs.json");
const areas = read("areas.json").areas;
const trip = read("trip.json");

const isos = unique(countries, "iso", "country");
const codes = unique(cities, "code", "city");
codes.add("YTO"); // home city, used only by the home airport
const actIds = unique(activities, "id", "activity");
const hubIds = unique(hubs.hubs, "hubId", "hub");
unique(areas, "id", "area");

for (const c of cities) {
  if (!isos.has(c.country)) fail(`city ${c.code}: unknown country ${c.country}`);
  if (!/^[A-Z]{3}$/.test(c.code)) fail(`city ${c.code}: code must be three capital letters`);
  if (Math.abs(c.lat) > 90 || Math.abs(c.lon) > 180) fail(`city ${c.code}: bad coordinates`);
}
const actCity = new Map(activities.map((a) => [a.id, a.city]));
for (const a of activities) {
  if (!codes.has(a.city)) fail(`activity ${a.id}: unknown city ${a.city}`);
  if (a.mapsQuery !== undefined && (typeof a.mapsQuery !== "string" || a.mapsQuery.length < 4)) fail(`activity ${a.id}: bad mapsQuery`);
}
for (const l of links) {
  if (!codes.has(l.from)) fail(`link: unknown city ${l.from}`);
  if (!codes.has(l.to)) fail(`link: unknown city ${l.to}`);
}
for (const h of hubs.hubs) {
  if (!codes.has(h.cityCode)) fail(`hub ${h.hubId}: unknown city ${h.cityCode}`);
  for (const s of h.serves ?? []) if (!codes.has(s)) fail(`hub ${h.hubId}: serves unknown city ${s}`);
}
if (!hubIds.has(hubs.home)) fail(`home hub ${hubs.home} missing`);
for (const [city, modes] of Object.entries(hubs.defaults)) {
  if (!codes.has(city)) fail(`defaults: unknown city ${city}`);
  for (const [mode, hub] of Object.entries(modes)) if (!hubIds.has(hub)) fail(`defaults ${city}.${mode}: unknown hub ${hub}`);
}
for (const l of hubs.links ?? []) {
  if (!hubIds.has(l.from) || !hubIds.has(l.to)) fail(`hub link ${l.from}-${l.to}: unknown hub`);
}
for (const a of areas) if (!codes.has(a.city)) fail(`area ${a.id}: unknown city ${a.city}`);
for (const a of areas) {
  if (a.radiusKm !== undefined && !(typeof a.radiusKm === "number" && a.radiusKm >= 0.2 && a.radiusKm <= 10)) fail(`area ${a.id}: radiusKm must be a number from 0.2 to 10 (default 1.5)`);
}

const routeIds = new Set();
const summary = [];
for (const file of trip.routes) {
  const r = read(file);
  if (routeIds.has(r.id)) fail(`duplicate route ${r.id}`);
  routeIds.add(r.id);
  let nights = 0;
  r.stops.forEach((s, i) => {
    nights += s.nights;
    if (!codes.has(s.city)) fail(`${r.id} stop ${i + 1}: unknown city ${s.city}`);
    for (const p of s.plans ?? []) {
      if (!actIds.has(p)) fail(`${r.id} stop ${i + 1}: unknown activity ${p}`);
      else if (actCity.get(p) !== s.city) fail(`${r.id} stop ${i + 1}: ${p} is in ${actCity.get(p)}, not ${s.city}`);
    }
  });
  summary.push(`${r.id}: ${r.stops.length} stops, ${nights} nights`);
}

console.log(
  `${countries.length} countries, ${cities.length} cities, ${hubs.hubs.length} hubs, ${links.length} links, ` +
    `${activities.length} activities, ${areas.length} areas, ${trip.routes.length} routes`,
);
for (const s of summary) console.log(`  ${s}`);
if (errors.length) {
  console.error(`\n${errors.length} problem(s):\n  ${errors.join("\n  ")}`);
  process.exit(1);
}
console.log("Seed data is consistent.");
