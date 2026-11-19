# Trip Graph Explorer Spec

Nov 18, 2026 · Trippr (Asia 2027) · feature spec, ready to build

## Overview

Trippr already stores the trip as a graph: routes, stops, cities, countries, activities, tags, votes and travel links. Today the app only shows it as lists, ticket cards and a flat map. The **Trip Graph Explorer** shows the graph itself:

- a **2D knowledge-graph viewer** for the trip, one route, or one city's neighbourhood
- a **3D globe overlay** that puts the same nodes at their real coordinates, with flights as raised arcs and trains as lines along the ground.

It also adds the nodes the group keeps asking about:

- **hotels**, in **areas worth staying in**
- the **stations and airports** each leg actually uses
- **legs and tickets** that join them.

Colour tags tell the kinds of activity apart; shape is always a second channel, so nothing relies on colour alone.

Users are the same group: Brady (owner) and 4 to 5 friends (editors and viewers), mostly on phones.

## Goals

- See the whole trip as a graph: what connects to what, and which activities, hotels and hubs each route uses.
- Flip the same graph onto a 3D globe to see the journey's shape: where the flights are, where the trains run, how far apart things are.
- Tell activities apart at a glance by colour tag (sport, tech, nature, culture, food), planned vs. idea, fixed-date events, and how popular they are.
- Plan where to stay: shortlist hotels in good areas per city, vote on them, mark one as booked per stop.
- Model real transport: a flight goes from an airport to an airport, a train from a station to a station. Store each leg's operator, number, times, price and booking status.
- Keep the portfolio story: one Cypher graph export feeds both views, works on FalkorDB and Neo4j, and is tested on both.

**Not in this version:** booking hotels or tickets inside Trippr, live prices or availability, turn-by-turn directions inside cities, offline 3D.

## Features

Rows 1 to 7 are the MVP (phases 1 and 2); the stretch rows come later.

| # | Feature | Done when | Scope |
|---|---|---|---|
| 1 | Hubs: stations and airports | Every seeded stop's arrival leg starts and ends at a real Station or Airport node with code, name, coordinates and city | MVP, phase 1 |
| 2 | Legs and tickets | An editor can add a leg to a stop (mode, operator, number, depart/arrive times, price, status idea/held/booked, booking reference) and it appears in the editor, checks and budget | MVP, phase 1 |
| 3 | Areas and hotels | An editor can add an area with vibe tags and a hotel in it, shortlist hotels per stop, mark one booked; the hotel's price feeds the budget layer | MVP, phase 1 |
| 4 | 2D graph viewer | The Graph tab shows the trip, route or city subgraph with the legend, filters, search, click to focus/expand, a details panel and a list fallback | MVP, phase 1 |
| 5 | Colour and legend system | Activity tags, planned/idea, fixed-date and votes are encoded with colour **and** shape/size; the palette passes the contrast and colour-blind checks below | MVP, phase 1 |
| 6 | 3D globe overlay | A 2D/3D toggle places nodes on a globe: flights as raised great-circle arcs, trains and boats along the ground, hotels and activities near their city | MVP, phase 2 |
| 7 | Journey playback and camera presets | "Play route" animates the journey stop by stop; each route has a camera preset; zoomed out, nodes cluster | MVP, phase 2 |
| 8 | Compare routes in the graph | Two routes overlaid: shared nodes neutral, route A only and route B only in two distinct styles | Stretch |
| 9 | Hub-level pathfinding | Pathfinding runs over station and airport LINKs ("which station do I leave from?") | Stretch |
| 10 | Ask the trip on the graph | An answer from "Ask the trip" highlights the matching subgraph | Stretch |
| 11 | Shareable snapshot | Export the current view as PNG, or a read-only link to it | Stretch |

## Architecture

The stack doesn't change, and nothing new is hosted. The explorer adds:

- **API:** a graph export module in the Fastify API (`/trips/:id/graph`) built from portable Cypher, plus CRUD for the new node types.
- **Web:** a `graph` route with two code-split renderers, so the rest of the app doesn't load their JavaScript.
- **Database:** new nodes and relationships, plus a migration that moves existing data across.

```
Browser ──► /trips/:id/graph?view=2d|3d ── TanStack Query ──► GET /trips/:id/graph (ETag)
   │                                                              │
   ├─ 2D: Cytoscape.js + fcose layout (Web Worker)                ├─ role check (viewer)
   └─ 3D: MapLibre GL 5 globe + deck.gl overlay (arcs, paths)     └─ 4 parallel Cypher reads → GraphJSON
```

| Layer | Choice | Why |
|---|---|---|
| 2D renderer | **Cytoscape.js** with the `cytoscape-fcose` layout (both MIT) | Built-in node shapes (shape is our second channel), styling, compound nodes, plenty fast for under 2,000 elements, mature. The preset layout gives the pinned-geography mode |
| 3D renderer | **MapLibre GL 5 globe projection** + **deck.gl** `MapboxOverlay` (spike first; see below) | Reuses the map stack and free OpenFreeMap tiles; zooms from globe to street level for hotels and areas; deck.gl adds raised arcs and smooth paths |
| Layout off the main thread | Web Worker running fcose; positions cached per scope in `sessionStorage` | Keeps phones responsive |
| Graph API | One module `repositories/graph.ts` with `.cypher` files under `cypher/graph/` | Same pattern as the other repositories; works on both databases |
| Caching | ETag = hash of the trip's max `version` plus the latest write time of activities, hotels and legs; `Cache-Control: private, max-age=0, must-revalidate` | Cheap 304s on refetch; live updates (when built) invalidate it |

### Choosing the 3D library

| Option | Fit with the app | Raised flight arcs | Street-level zoom | Bundle (gzip, approximate) | Licence | Phones |
|---|---|---|---|---|---|---|
| **MapLibre GL 5 globe + deck.gl overlay** | Already used for the route map, same tiles and style | Yes, `ArcLayer` (`greatCircle: true`) | Yes | MapLibre already loaded; deck.gl core + layers about 250 to 350 KB | BSD-3 / MIT | Good; one WebGL context |
| MapLibre GL 5 globe only | Same | No: lines are draped on the surface, and flights can only be dashed great-circle lines | Yes | 0 extra | BSD-3 | Best |
| globe.gl / three-globe | A second map stack, with an image texture instead of map tiles | Yes, polished | No (texture only) | About 200 KB plus three.js about 160 KB | MIT | Good |
| CesiumJS | Heavy, separate stack; terrain and imagery want a Cesium ion token | Yes | Yes, with 3D terrain | About 1.5 to 3 MB | Apache-2.0 (ion services metered) | Weakest |
| deck.gl `GlobeView` | No basemap except via a `TileLayer`, which needs wiring; still experimental | Yes | Partial | About 300 KB | MIT | OK |

**Recommendation:** MapLibre GL 5 globe projection with a deck.gl `MapboxOverlay`, pinned to exact versions.

**Spike first (1 day):**
- Does deck.gl's interleaved overlay render `ArcLayer` and `PathLayer` correctly on MapLibre's globe at the versions we pin?
- Do arcs drawn behind the globe hide properly?

**Fallback if the spike fails:** plain MapLibre globe with flights as dashed great-circle lines (computed client-side), plus a small three.js custom layer for raised arcs only. Mark this choice in the README trade-offs.

## Graph data model (additions)

The modelling rule stays the same: **things belong to places, not plans.** Hotels belong to areas, areas to cities, and hubs serve cities. A stop chooses a hotel and arrives via a leg, just as it already plans activities.

### New nodes

| Label | Key properties | Notes |
|---|---|---|
| Area | id, name, lat, lon, vibes[], note, source | A neighbourhood worth staying in ("Sheung Wan", "Canggu"). Vibes: `food`, `nightlife`, `quiet`, `central`, `transit`, `beach`, `culture`, `budget`. Per trip, like activities |
| Hotel | id, name, url, lat, lon, priceCadPerNight, priceBasis (`room` or `person`), sleeps, rating, notes, createdBy | Per-trip library entry: shortlisted once, shared by every route through that city |
| Station | id (`stn-xian-north`), name, nameLocal, code (official code where known), lat, lon, kind (`hsr`, `rail`, `metro`, `maglev`, `ferry`) | Reference data shared by all trips (like City) |
| Airport | iata (unique), icao, name, lat, lon | Reference data shared by all trips |
| Leg | id, mode (`flight`, `hsr`, `train`, `road`, `boat`, `maglev`), operator, number, departAt, arriveAt (local ISO 8601 with offset), durationMin, priceCad (per person), status (`idea`, `held`, `booked`), bookingRef, seat, source, asOf | One ticket segment. A stop can arrive via several chained legs (fly YYZ to HND, then train) |

### New relationships

| Pattern | Properties | Purpose |
|---|---|---|
| (Area)-[:IN]->(City) | | Areas belong to a city |
| (Area)-[:FOR]->(Trip) | | Per-trip library, as for activities |
| (Hotel)-[:IN]->(Area) | | Hotels belong to an area (and so to a city) |
| (Hotel)-[:FOR]->(Trip) | | Per-trip library |
| (Stop)-[:STAYS_AT]->(Hotel) | status (`shortlist`, `chosen`, `booked`), rooms, nights (defaults to stop nights) | What this route picks; at most one `chosen`/`booked` per stop |
| (User)-[:VOTED]->(Hotel), (User)-[:VOTED]->(Area) | value, at | Same voting as activities |
| (Station)-[:SERVES]->(City), (Airport)-[:SERVES]->(City) | | Which city a hub serves (Shenzhen North and Futian both serve SZX) |
| (Stop)-[:ARRIVES_VIA]->(Leg) | seq | How this stop is reached; `seq` orders chained legs |
| (Leg)-[:FROM]->(Station or Airport), (Leg)-[:TO]->(Station or Airport) | | The real endpoints of a ticket |
| (Station or Airport)-[:LINK]->(Station or Airport) | mode, minutes, costCad, source, asOf | Hub-level travel options for pathfinding (stretch #9) |
| (Activity)-[:NEAR]->(Station) | walkMin | Optional: nearest station, for the graph view and planning |

### Modelling rules

- Hotels and areas are per trip (the same `FOR` edge as activities), so strangers' trips never show up. Stations and airports are shared reference data, like City.
- Stay dates are computed from the stop, never stored (same rule as stop dates). A booked hotel whose stay doesn't match its stop's dates after a reorder becomes a **check** (like fixed-date events).
- `Leg.departAt` must fall on the stop's arrival day or the day before (overnight trains and flights); otherwise a check warns.
- **Budget:** a chosen hotel overrides `Stop.stayCadPerNight`. Per person = price / sleeps when `priceBasis = room`. Chosen legs' `priceCad` override `Stop.arriveCostCad`.
- Duplicating a route copies `STAYS_AT` and `ARRIVES_VIA` edges and their legs; legs are copied, not shared, because they belong to one route's timeline.
- **Privacy:** `bookingRef` and `seat` are returned only to editors and the owner, never to viewers or the demo account.

### Migration from today's model

1. Create Station and Airport nodes from the seed (below). Move the two place nodes now stored as cities (`PVG` Pudong Airport, `LYD` Longyang Road) to Airport/Station nodes, re-pointing their LINK edges. Delete the City versions.
2. For each existing stop, create one `idea` Leg from `Stop.arriveMode` and `arriveNote`. Endpoints come from a default hub per city and mode (for example, `hsr` into CKG uses Chongqing West). Keep `arriveMode` as a derived, read-only field for one release, then drop it.
3. Copy each City-LINK to a hub-LINK using the same default-hub map. Keep City-LINK for current pathfinding until stretch #9 ships, then derive it.
4. Migrations are idempotent `MERGE` scripts in `db/migrations/2026-11-graph-explorer/{falkordb,neo4j}.cypher`, run by the existing startup bootstrap behind a `DB_AUTO_MIGRATE` version marker.

### Seed: hubs for Asia 2027 (verify before relying on them)

Coordinates are approximate (±0.01°). Rows marked **verify** are planning assumptions the group should check against tickets.

| Kind | Id / code | Name | Serves | Lat, Lon | Notes |
|---|---|---|---|---|---|
| Airport | YYZ | Toronto Pearson | Toronto (home) | 43.68, -79.63 | Home departure |
| Airport | HND | Tokyo Haneda | TYO | 35.55, 139.78 | **verify**: Haneda vs. Narita (NRT 35.77, 140.39) depends on the ticket |
| Airport | PEK / PKX | Beijing Capital / Daxing | BJS | 40.08, 116.58 / 39.51, 116.41 | **verify** which one the Tokyo flight uses |
| Station | stn-beijing-west | Beijing West | BJS | 39.89, 116.32 | Usual departure for Xi'an high-speed trains (**verify**) |
| Station | stn-xian-north | Xi'an North | SIA | 34.38, 108.94 | |
| Station | stn-chongqing-west | Chongqing West | CKG | 29.50, 106.43 | **verify**: some Xi'an trains use Chongqing North (29.61, 106.55) |
| Station | stn-guangzhou-south | Guangzhou South | CAN | 22.99, 113.27 | |
| Station | stn-shenzhen-north | Shenzhen North | SZX | 22.61, 114.03 | |
| Station | stn-futian | Futian | SZX | 22.54, 114.06 | Underground; cross-border trains to West Kowloon (**verify** which station the ticket uses) |
| Station | stn-west-kowloon | Hong Kong West Kowloon | HKG | 22.30, 114.17 | Cross-border high-speed terminus |
| Airport | HKG | Hong Kong International | HKG | 22.31, 113.91 | Flight to Hanoi |
| Airport | HAN | Hanoi Noi Bai | HAN | 21.22, 105.81 | |
| Airport | SGN | Ho Chi Minh City Tan Son Nhat | SGN | 10.82, 106.66 | |
| Airport | LBJ | Komodo Airport, Labuan Bajo | LBJ / KOM | -8.49, 119.89 | Boat from the harbour to Komodo |
| Airport | DPS | Bali Ngurah Rai | DPS | -8.75, 115.17 | |
| Airport | PVG / SHA | Shanghai Pudong / Hongqiao | SHA | 31.14, 121.81 / 31.20, 121.34 | "With Shanghai" route |
| Station | stn-shanghai-hongqiao | Shanghai Hongqiao | SHA | 31.19, 121.32 | From Xi'an North / Beijing South (**verify**) |
| Station | stn-longyang-road | Longyang Road (maglev) | SHA | 31.20, 121.56 | Replaces the `LYD` city node |

Official railway codes are left blank until the group confirms them from tickets.

### Seed: areas to stay (suggestions to vote on, not recommendations)

| City | Areas (vibes) |
|---|---|
| Tokyo | Shibuya (nightlife, transit), Asakusa (culture, quiet), Shinjuku (central, nightlife) |
| Beijing | Dongcheng hutongs near Gulou (culture), Sanlitun (nightlife, food) |
| Xi'an | Bell Tower / Muslim Quarter (central, food) |
| Chongqing | Jiefangbei / Yuzhong (central, nightlife) |
| Guangzhou | Tianhe (transit), Yuexiu (culture, food) |
| Shenzhen | Futian (central, transit), Nanshan (tech) |
| Hong Kong | Sheung Wan (food, culture), Tsim Sha Tsui (central, transit) |
| Hanoi | Old Quarter / Hoan Kiem (food, central) |
| Ho Chi Minh City | District 1 (central, nightlife), District 3 (quiet, food) |
| Labuan Bajo / Komodo | Harbour front (transit) |
| Bali | Canggu (beach, food), Ubud (culture, quiet), Uluwatu (beach) |

No hotels are seeded: the group adds real ones, so nothing is made up.

## Key queries

All queries are parameterised, return plain maps (no node objects, so the two databases behave the same), and are read-only. The graph export runs four of them in parallel and merges the results in TypeScript (`graph.ts`), so no `UNION` dialect differences arise and each part can be cached or profiled on its own.

**G1. Route skeleton (routes, stops, cities, countries)**
```cypher
MATCH (t:Trip {id: $tripId})-[:HAS_ROUTE]->(r:Route)
WHERE $routeId IS NULL OR r.id = $routeId
MATCH (r)-[:HAS_STOP]->(s:Stop)-[:AT]->(c:City)-[:IN]->(k:Country)
RETURN r {.id, .name, .tags, .isCurrent} AS route,
       s {.id, .order, .nights} AS stop,
       c {.code, .name, .lat, .lon} AS city,
       k {.iso, .name, .color} AS country
ORDER BY r.createdAt, s.order
```

**G2. Activities with tags, planned flags and votes** (aggregate before the next `OPTIONAL MATCH`, as in query 2 today)
```cypher
MATCH (a:Activity)-[:FOR]->(t:Trip {id: $tripId}), (a)-[:IN]->(c:City)
WHERE $cityCode IS NULL OR c.code = $cityCode
OPTIONAL MATCH (a)-[:TAGGED]->(tg:Tag)
WITH t, a, c, collect(tg.name) AS tags
OPTIONAL MATCH (:User)-[v:VOTED]->(a)
WITH t, a, c, tags, sum(coalesce(v.value, 0)) AS votes
OPTIONAL MATCH (t)-[:HAS_ROUTE]->(r:Route)-[:HAS_STOP]->(s:Stop)-[:PLANS]->(a)
WHERE $routeId IS NULL OR r.id = $routeId
RETURN a {.id, .title, .when, .costCad} AS activity, c.code AS cityCode, tags, votes,
       collect(DISTINCT s.id) AS plannedAt
```

**G3. Areas, hotels and stays**
```cypher
MATCH (h:Hotel)-[:FOR]->(:Trip {id: $tripId}), (h)-[:IN]->(ar:Area)-[:IN]->(c:City)
WHERE $cityCode IS NULL OR c.code = $cityCode
OPTIONAL MATCH (s:Stop)-[st:STAYS_AT]->(h)
OPTIONAL MATCH (:User)-[v:VOTED]->(h)
WITH h, ar, c, collect(DISTINCT {stopId: s.id, status: st.status}) AS stays, sum(coalesce(v.value, 0)) AS votes
RETURN h {.id, .name, .lat, .lon, .priceCadPerNight, .priceBasis, .sleeps} AS hotel,
       ar {.id, .name, .lat, .lon, .vibes} AS area, c.code AS cityCode, stays, votes
```
(Areas with no hotels come from a sibling query `areas.cypher`. Entries in `stays` whose `stopId` is null are filtered out in TypeScript, the same FalkorDB/Neo4j null-map rule as today.)

**G4. Legs and hubs**
```cypher
MATCH (t:Trip {id: $tripId})-[:HAS_ROUTE]->(r:Route)-[:HAS_STOP]->(s:Stop)-[av:ARRIVES_VIA]->(l:Leg)
WHERE $routeId IS NULL OR r.id = $routeId
MATCH (l)-[:FROM]->(fromHub), (l)-[:TO]->(toHub)
RETURN s.id AS stopId, av.seq AS seq,
       l {.id, .mode, .operator, .number, .departAt, .arriveAt, .durationMin, .priceCad, .status} AS leg,
       {id: coalesce(fromHub.iata, fromHub.id), kind: labels(fromHub)[0], name: fromHub.name, lat: fromHub.lat, lon: fromHub.lon} AS fromHub,
       {id: coalesce(toHub.iata, toHub.id), kind: labels(toHub)[0], name: toHub.name, lat: toHub.lat, lon: toHub.lon} AS toHub
ORDER BY stopId, seq
```
(`bookingRef` is fetched by a separate editor-only query, never in the shared export.)

**G5. Expand a node.** One hop from any node id, limited by `$limit`, scoped to the trip through its `FOR`/`HAS_ROUTE` paths, used by click-to-expand in city scope.

**Indexes to add:** `Station.id`, `Airport.iata`, `Hotel.id`, `Area.id`, `Leg.id` (unique), plus an index on `Area.name`. Run `PROFILE` on G1 to G4 for the README section on query profiling.

## API design

The rules stay the same: zod-validated bodies, a role check through the owning trip, one error shape, and a version check on route-structure writes.

| Method | Path | Does | Minimum role |
|---|---|---|---|
| GET | /trips/:id/graph?scope=trip\|route\|city&routeId=&city=&types=&tags= | GraphJSON for the scope; ETag/304; truncated flag when over the limits | viewer |
| GET | /trips/:id/graph/nodes/:nodeId/neighbours?limit=50 | Expand one node (G5) | viewer |
| GET | /hubs?q=&city=&kind=station\|airport | Hub search for the leg form | signed in |
| GET | /cities/:code/areas?tripId= | Areas in a city, with votes | viewer |
| POST / PATCH / DELETE | /areas, /areas/:id | Create or edit an area { tripId, cityCode, name, lat, lon, vibes, note } | editor |
| GET | /trips/:id/hotels?city= | Hotel library with votes and stays | viewer |
| POST / PATCH / DELETE | /hotels, /hotels/:id | { tripId, areaId, name, url, lat, lon, priceCadPerNight, priceBasis, sleeps } | editor |
| PUT / DELETE | /stops/:id/stays/:hotelId | Shortlist, choose or book a hotel for a stop { status, rooms } | editor |
| PUT | /hotels/:id/vote, /areas/:id/vote | { value } | viewer |
| POST | /stops/:id/legs | Add a leg { mode, fromHubId, toHubId, operator, number, departAt, arriveAt, priceCad, status, bookingRef?, seq? } | editor |
| PATCH / DELETE | /legs/:id | Edit or remove a leg | editor |
| GET | /legs/:id/private | bookingRef and seat | editor |

**GraphJSON** (shared type in `packages/contracts`):
```ts
interface GraphNode {
  id: string;            // "city:CKG", "act:act-liziba", "hotel:h_x", "stn:stn-xian-north", "apt:HKG"
  type: "trip" | "route" | "stop" | "city" | "country" | "activity" | "hotel" | "area" | "station" | "airport" | "leg";
  label: string;
  lat?: number; lon?: number;          // every placeable node has coordinates
  attrs: Record<string, unknown>;      // type-specific fields, never booking references
  style: { tag?: string; planned?: boolean; fixedDate?: boolean; votes?: number; country?: string; status?: string };
}
interface GraphEdge { id: string; type: string; source: string; target: string; attrs?: Record<string, unknown> }
interface GraphJSON { nodes: GraphNode[]; edges: GraphEdge[]; meta: { scope: string; truncated: boolean; counts: Record<string, number>; generatedAt: string } }
```

**Limits:**
- At most 2,000 nodes and 5,000 edges. Over that, the response is truncated by priority (route skeleton first, then planned activities, chosen hotels and legs, then the rest) and `meta.truncated` is set.
- The response must be under 300 KB gzipped.
- The demo account gets the same graph, minus private fields.

## Frontend

**Entry points**
- A **Graph** tab in the trip nav (after Compare): `/trips/:id/graph`.
- A "View as graph" button on the route editor header (opens route scope) and on each city's activity drawer (opens city scope).
- Deep links keep all state in the URL: `?view=2d|3d&scope=route&route=route-main&focus=act:act-liziba&tags=tech,food&types=activity,hotel&layout=geo`.

**Screen layout**
- **Desktop:** filter bar and legend on top, canvas in the middle, details panel on the right (360px).
- **Phone:** a full-screen canvas, a bottom sheet for details, and filters in a sheet behind a "Filters (3)" button.

**Header:** the departure-board header shows the scope as flaps ("GRAPH · MAIN"), with the 2D/3D toggle styled as a board switch.

| Component | Responsibility |
|---|---|
| `GraphExplorer` | Reads URL state, fetches GraphJSON (TanStack Query, key `["graph", tripId, scope, routeId, city]`), applies client-side filters, owns selection |
| `GraphCanvas2D` | Cytoscape instance (dynamic import, `ssr: false`), style sheet from the palette tokens, fcose in a Web Worker, preset geo layout |
| `GlobeView` | MapLibre map with `projection: "globe"` and a dark style; deck.gl overlay layers; camera presets; journey playback |
| `Legend` | Node types (shape + colour), activity tags, planned/idea, fixed-date ring, vote size scale; each entry toggles a filter |
| `FilterBar` | Node types, tags, routes, countries, leg status (idea/held/booked), "planned only" |
| `NodeSearch` | Combobox over node labels and codes; choosing a result focuses the node in both views |
| `DetailsPanel` | Type-specific details with actions (plan/unplan, vote, edit, open in route editor, "Book" status for legs and hotels when editor) |
| `ListFallback` | An accessible table of the same filtered nodes (and edges grouped by node); shown when WebGL is unavailable, when the user prefers it, or on a "List" toggle |
| `JourneyPlayer` | Play, pause and step through the route; drives both the 2D highlight and the 3D camera |

**Interactions**
- **2D:**
  - Click or tap selects a node: it is highlighted along with its one-hop neighbourhood, everything else dims to 25%, and the details panel opens.
  - Double-click or the "Expand" button loads neighbours (G5) in city scope.
  - Drag pans, pinch or wheel zooms, and "Fit" resets the view.
- **Layout:**
  - `force` (fcose, default).
  - `geo`: nodes pinned by Web Mercator projection of lat/lon; nodes without coordinates are placed beside their parent.
  - Switching layouts animates the change (300 ms; skipped when the user prefers reduced motion).
- **3D:**
  - Cities sit at lat/lon. Hubs, areas, hotels and activities sit at their own coordinates, or on a small ring around the city (radius scaled to zoom) when they have none.
  - Zoomed out, below zoom 4, only cities and legs show, and items within a city cluster into a count bubble per type.
  - Selecting a node flies the camera to it.
- **Camera presets:** "Whole trip", one per route ("Main", "With Shanghai"), and one per country.
- **Journey playback:**
  - Animates along the legs in order: the arc or path draws over 1.5 s per leg, then the camera follows.
  - The timeline scrubber shows dates from the rules module.
  - Respects reduced motion by jumping instead of animating.
- **Empty states:**
  - No legs yet: "Add how you get to each stop to see the journey."
  - No hotels: "Shortlist a hotel in an area you like."
- **Loading:** a skeleton canvas with board-style flaps.
- **Errors:** the existing `ErrorNote`, plus a retry button.
- **WebGL unavailable or context lost:** fall back to `ListFallback` with a notice.

## Colour and legend system

Node *types* use shape first and a neutral or brand colour. Activity *tags* use the Okabe–Ito colour-blind-safe palette. Each colour comes in a light-paper variant (background `#F4EFE4`) and a dark-globe variant (`#0F151D`). Every fill also has a 1.5px outline in the opposite tone, so nodes hold their edges on both backgrounds. The colours are tokens in `globals.css` (`--node-*`, `--tag-*`), with a unit test that computes WCAG contrast against both backgrounds.

### Node types (second channel: shape)

| Node | Shape | Paper fill | Globe fill | Notes |
|---|---|---|---|---|
| City | Large circle | `#1B222B` | `#F4EFE4` | Labelled with the city code |
| Country | Hexagon (2D only) | country colour (existing) | country colour | Background grouping |
| Route | Rounded rectangle | `#FFC23D` (amber) | `#FFC23D` | Board style |
| Stop | Small diamond | `#59626E` | `#C9CED6` | Numbered by order |
| Activity | Circle | tag colour (below) | tag colour | Size = votes |
| Area | Dashed-outline circle, translucent fill | `#9C7A00` (fill 20%) | `#F0E442` (fill 20%) | "Where to stay" zones |
| Hotel | Rounded square with a bed icon | `#2B6CB0` | `#56B4E9` | Solid when chosen or booked, outline when shortlisted |
| Station | Triangle | `#2E7A59` | `#4CC38A` | Rail green, as on the route map |
| Airport | Inverted triangle with a plane icon | `#3867C8` | `#7AA2F7` | Flight blue, as on the route map |
| Leg | Edge, not a node, in 3D; small pill in 2D | by mode | by mode | Flight dashed arc, rail solid, boat or road dotted |

### Activity tags (Okabe–Ito)

| Tag | Colour | Icon (second channel) |
|---|---|---|
| sport | `#D55E00` vermilion | ball |
| tech | `#0072B2` blue | chip |
| nature | `#009E73` bluish green | leaf |
| culture | `#CC79A7` reddish purple | columns |
| food | `#E69F00` orange | bowl |
| untagged / other | `#8C939C` grey | dot |

An activity with several tags uses its first tag in this order (sport, tech, nature, culture, food) for the fill; the details panel lists them all. A 2-segment pie fill is an optional stretch.

### Status encodings (shape and size only, never colour alone)

- **Planned on the current scope:** solid fill. **Idea:** white or dark fill with a coloured 3px ring.
- **Fixed-date event:** an outer ring in stamp red `#C4452A` (paper) or `#FF7A59` (globe), plus a star badge.
- **Votes:** radius 14px + 3px per net vote, clamped to 10 to 30px. A negative score adds a struck-through badge.
- **Leg status:** `booked` uses a full-opacity line with a check badge; `held` a 70% opacity line; `idea` 40% opacity with a "?" badge.

**Checks:**
- **Colour blindness:** run the palette through deuteranopia, protanopia and tritanopia simulation (for example with a small `chroma-js` script in the unit tests) and assert a ΔE above 20 between any two tag colours.
- **Contrast:** label text keeps 4.5:1 against its background, using a label halo.

## Accessibility

- Every node and edge in the canvas is mirrored in `ListFallback`, which is focusable and reachable with "Skip to list".
- **Keyboard:**
  - Tab moves between the filter bar, canvas and panel.
  - Inside the canvas, arrow keys move between nodes in reading order (by type, then label), Enter opens details, E expands, F fits, and Escape clears the selection.
- The canvas has `role="application"` and an `aria-live` region announcing "Selected Liziba station, tech, planned in Main, 3 votes".
- Reduced motion: no animated layout changes, no flying camera or journey animation (steps instead).
- Touch targets are at least 44px (node hit areas are padded beyond the drawn shape).

## Performance budgets

| Measure | Budget |
|---|---|
| Graph JSON, trip scope | Under 300 KB gzip; API p95 under 600 ms warm, under 2.5 s on a cold Cloud Run start |
| 2D first render, 500 nodes | Under 1.5 s on a mid-range Android phone (layout in a worker; cached positions make the second visit under 400 ms) |
| 2D interaction | 60 fps pan/zoom on desktop, 30 fps or better on a mid-range phone |
| 3D globe | 30 fps or better on a mid-range phone with the trip scope; 60 fps desktop |
| Extra JS on /graph | 2D chunk under 150 KB gzip; 3D chunk under 350 KB gzip; zero bytes added to other routes |
| Memory | One WebGL context; the 2D and 3D views mount one at a time |

## Testing

| Area | Approach |
|---|---|
| Rules | Vitest: hotel stay dates vs. stop dates after a reorder, leg-day checks (overnight trains), budget override from chosen hotel and legs, per-room vs. per-person pricing |
| Graph mapper | Vitest: GraphJSON assembly from G1 to G4 rows, null-map filtering (FalkorDB), truncation priority, private-field stripping |
| Palette | Vitest: WCAG contrast of every token on both backgrounds; colour-blind ΔE between tag colours |
| Queries and API | Integration tests on **both** FalkorDB and Neo4j (existing CI matrix): graph endpoint per scope, role checks (viewer and demo never see `bookingRef`), ETag/304, limits, CRUD for areas, hotels, stays and legs, migration idempotence (run twice, same counts), duplicate-route copies stays and legs |
| UI flows | Playwright: open the Graph tab; the node count in `ListFallback` matches the API; filter by tag changes the count; a deep link with `focus=` opens the details panel; plan an activity from the panel and see it in the route editor |
| WebGL smoke | Playwright (Chromium; SwiftShader in CI): 3D toggle mounts a canvas; no `webglcontextlost`; a screenshot has more than 5% non-background pixels; journey playback advances the scrubber. On failure, assert the list fallback appears |
| Performance | A Playwright trace on a generated 500-node fixture records first render and fps; it fails if over budget by more than 25% |
| Accessibility | `@axe-core/playwright` on the Graph page in list and canvas modes; keyboard-only walkthrough test |

## Build plan

**Phase 1: data and 2D viewer (about 5 days)**
- ☐ Spike: deck.gl overlay on the MapLibre globe at pinned versions (decide 3D library; 1 day, can run in parallel)
- ☐ Schema and migration: Station, Airport, Area, Hotel, Leg nodes and edges; move PVG/LYD; legs from `arriveMode`; hub-LINKs
- ☐ Seed hubs and suggested areas (verify list with the group)
- ☐ API: graph export (G1 to G5), hubs search, CRUD for areas, hotels, stays and legs; budget and checks updated
- ☐ Route editor: "Getting there" leg editor and "Where to stay" hotel picker on each stop card
- ☐ Graph tab: `GraphCanvas2D`, `Legend`, `FilterBar`, `NodeSearch`, `DetailsPanel`, `ListFallback`, URL state
- ☐ Tests: integration on both databases, Playwright flows, palette checks

**Phase 2: 3D globe (about 4 days)**
- ☐ `GlobeView` with nodes, arcs, paths and clustering
- ☐ Camera presets, journey playback shared with 2D highlight
- ☐ WebGL smoke tests, performance traces, reduced-motion behaviour
- ☐ README: screenshots, the graph export query explained, 3D library trade-offs

**Phase 3: stretch**
- ☐ Compare two routes in the graph; hub-level pathfinding; Ask-the-trip highlighting; PNG/link snapshot

## Risks

| Risk | Mitigation |
|---|---|
| deck.gl interleaving on the MapLibre globe has gaps at our versions | Spike first; fallback to draped dashed great-circles plus a three.js arc layer |
| Low-end phones struggle with WebGL | Clustering, one context, 2D default on phones, list fallback |
| Station and airport data is wrong (wrong station for a ticket) | Every hub row has `source`/`asOf`; seed marks uncertain rows; editors can change a leg's hubs in seconds |
| Booking references leak to viewers or the demo | Separate editor-only endpoint; integration tests assert absence in the shared export |
| Graph gets cluttered | Scope by default to the current route; filters persisted in the URL; city scope for detail |
| Bundle size grows | Dynamic imports per view; size budget checked in CI (`next build` output parsed) |
| Migration drift between FalkorDB and Neo4j | One migration file per dialect, both run in the CI matrix twice for idempotence |

## Open questions

- ☐ Hotel price: per room or per person by default, and how many share a room (2 or 3)?
- ☐ Should viewers see booking references, or only that a leg or hotel is booked?
- ☐ Areas: per trip (simpler, current proposal) or shared across trips like cities?
- ☐ Default view on phones: 2D graph, 3D globe, or the list?
- ☐ Include the home legs (Toronto to Tokyo, Bali to Toronto) in the graph and budget?
- ☐ Which station and airport is each confirmed ticket actually using (the **verify** rows above)?
- ☐ Should legs fully replace `arriveMode` after one release, or keep both?
- ☐ Is a dark globe style acceptable next to the light paper app, or should the globe follow the paper theme?
