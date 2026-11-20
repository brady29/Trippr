# Places, Map, Itinerary and Trip Assistant Spec

Nov 19, 2026 · Trippr (Asia 2027) · feature spec, ready to build

## Overview

Trippr can now plan routes, show the trip as a graph, list what's booked, and read confirmations and social links that arrive in the trip inbox. This spec covers the next step: making every idea a real **place** you can find, see on a map, put on a day, and ask questions about.

| # | Feature | In one line |
|---|---|---|
| 1 | **Map tab** | Every stop, activity, hotel, station and airport on one map, with the route drawn between them |
| 2 | **Day-by-day itinerary and calendar feed** | The current route as a list of days, activities planned onto days, and a calendar link that stays in sync |
| 3 | **Trip assistant** | Ask questions about the trip in plain words; editors get suggested changes they can apply with one click |
| 4 | **Link lookup** | When a link reaches the inbox, find the place behind it and attach the right links: website, Google Maps pin, tickets, reservations |
| 5 | **Portfolio polish** | LICENSE, refreshed README with screenshots, error tracking, an inbox eval set, and checks for a public repo |

Feature 4 comes first in the build because the map, the itinerary and the assistant all need activities that know where they are.

Users are the same group: Brady (owner) and 4 to 5 friends (editors and viewers), mostly on phones.

## Goals

- Turn a TikTok, Instagram reel, blog post or Google Maps share that someone emails in into an activity that already has its website, a Google Maps pin, a ticket link if it needs one, and a spot on the map.
- See the whole trip on one map and filter it by route, day and layer.
- Know what each day looks like: where you wake up, how you travel, what's planned, and which days are still empty.
- Keep the plan in everyone's phone calendar without exporting files again after each change.
- Ask "what's still unbooked in China?" or "find a free day near Osaka for a day trip" and get an answer grounded in the trip graph, with changes proposed rather than made.
- Make the public repo read well as a portfolio piece.

**Not in this version:** live prices, booking inside Trippr, turn-by-turn directions, offline maps, an assistant that changes the trip without a person clicking Apply, reply emails from the inbox (these need a domain we own).

## Features

| # | Feature | Done when | Phase |
|---|---|---|---|
| 4a | Places on activities | An activity can hold coordinates, an address and links (website, Google Maps, tickets, reservations, source). Editors can find, change or drop the pin by hand | 1 |
| 4b | Link lookup in the inbox | A link that arrives by email or paste becomes an activity with the right links attached and a pin when the place can be found; anything unsure waits for a person | 1 |
| 1 | Map tab | `/trips/:id/map` shows the chosen route with layers for activities, hotels, hubs and areas, a list synced to the map, and a "not on the map yet" count | 2 |
| 2a | Itinerary | `/trips/:id/itinerary` lists the route day by day in local time. Editors drag activities onto days and see conflicts | 3 |
| 2b | Calendar feed | Each member can subscribe to a private calendar link for the current route that updates as the plan changes | 3 |
| 3a | Ask the trip | Any member can ask questions; answers cite the stops, activities and bookings they used and can highlight them on the map | 4 |
| 3b | Suggested changes | For editors, the assistant proposes changes as cards; Apply runs the normal API as that editor | 4 |
| 5 | Portfolio polish | LICENSE, README refresh with screenshots and a GIF, Sentry on web and API, a secret scan in CI, Dependabot, and an inbox eval set | Alongside 1 |

## Architecture

Nothing new is hosted. The changes:

- **API (Cloud Run):** a place-lookup service, a geocoder client, itinerary and calendar routes, and an assistant route that streams answers.
- **Web (Vercel):** Map and Itinerary tabs, an Ask panel, and link chips on activities.
- **Claude:** the inbox reader gains a lookup step that uses Anthropic's server-side **web search** and **web fetch** tools. The assistant uses the same model with tools over the trip graph.
- **Geocoding:** OpenStreetMap through Nominatim, behind a small interface so the provider can change.

```
Inbox email / paste ──► reader (Claude) ──► lookup (Claude + web search/fetch) ──► geocoder (OSM) ──► apply as the sender
                                                  │                                     │
                                                  └─ links: website, tickets, maps      └─ lat/lon, address

Browser ── Map tab ─────────► GET /trips/:id/graph (existing export, now with place coordinates)
        ── Itinerary tab ───► GET /routes/:id/itinerary
        ── Calendar app ────► GET /cal/:token.ics
        ── Ask panel ───────► POST /trips/:id/assistant (SSE) ──► Claude + trip tools (run as the asking user)
```

### Why not the Google Places API for pins

The obvious way to "find the Google Maps pin" is the Places API. It is the wrong fit here:

- **Non-Google maps.** The Google Maps Platform terms don't allow showing Places content on a non-Google map, and Trippr's map is MapLibre with OpenFreeMap tiles.
- **Caching.** The terms allow storing place IDs, but coordinates may be cached for only 30 days, so every pin would need a refresh job.
- **Coverage.** Google's place data in mainland China is thin, and the app is blocked there without a VPN.

**What we do instead:**

- The **Google Maps link** uses the keyless Maps URLs format the app already uses (`googleMapsUrl` in `packages/contracts/src/maps.ts`). It opens the pin in the Google Maps app on phones, needs no API key, and carries no terms problem. When the incoming link is itself a Google Maps link, we keep it as is, since that's the most exact pin.
- **Map coordinates** come from OpenStreetMap, whose data we may store and show on our own map with attribution (OpenFreeMap already shows that attribution).
- **China stops** also get an **Apple Maps** link, which uses local map data inside China.

Confirm the Google terms points before relying on them. If the app ever switches to a Google map, Places becomes the better choice and the geocoder interface makes that swap small.

## Feature 4: Link lookup and places

### What happens to an incoming link

The reader already pulls activities out of a message (title, city, source URL, tags). Lookup adds one step for each activity or hotel that lacks a place:

1. **Classify the link** by its host and path, in code (table below). No network call.
2. **Identify the place.** Use the oEmbed title and caption for YouTube and TikTok, which we already fetch. Ask Claude with `web_search` and `web_fetch` for the place's name, address, official website, ticket or reservation page and, for events, the date.
3. **Geocode** the name and address with the geocoder, biased to the stop city.
4. **Sanity check.** The point must be within 80 km of the city (150 km is accepted but flagged "day trip"). The name must loosely match. Any website must appear in a search or fetch result Claude actually received.
5. **Apply.** The existing rules decide: auto-apply when the sender is trusted, is an editor, and nothing waits on a choice. A place found with low confidence still applies the activity but leaves the pin for a person ("Check the pin").

### Which links we attach, by incoming link type

| Incoming link | What we look for | Links attached to the activity |
|---|---|---|
| Social video or post about a place (TikTok, Instagram, YouTube, Xiaohongshu, Douyin, Facebook) | The place named in the caption, title or email text, confirmed by web search | Google Maps pin, official website, tickets if it's a ticketed attraction, the video kept as **Source** |
| Social post about an event (concert, match, festival) | Event page, date, venue | **Tickets** or event page, venue Maps pin, `when.on` set to the date |
| Google Maps link (`maps.app.goo.gl`, `google.com/maps/place/…`) | Name and address of that place | The link itself as **Google Maps**, website from search, pin from the geocoder |
| A place's own website | Name and address from the page | **Website** = the link, Maps pin |
| Ticket or tour page (Klook, KKday, GetYourGuide, Trip.com attractions, an official ticket site) | Venue or meeting point, price | **Tickets** = the link, Maps pin to the venue, official website, cost in CAD when stated |
| Restaurant booking page (Tabelog, OpenTable, Dianping, CatchTable, TableCheck) | The restaurant | **Reserve** = the link, Maps pin, website |
| Article or listicle ("10 ramen shops in Tokyo") | Up to 5 named places | One activity each with Maps pin and website, the article as **Source**. More than 5 places, or no clear city, waits for a person |
| Hotel page or hotel confirmation | The hotel's address | Maps pin for the hotel, hotel website. The booking link and reference are handled as today |
| Transport (airline, rail timetable) | Nothing new | The existing leg flow. Stations and airports already have coordinates |
| Anything else, or no place found | Nothing | The link is kept as **Source** with "Couldn't find the place" for a person |

**China stops** also get an Apple Maps link (`https://maps.apple.com/?q=<name>&ll=<lat>,<lon>`) and an Amap link (format checked by hand before shipping).

### Calling Claude for lookup

- **Model and request:** `INBOX_MODEL` (default `claude-opus-5-5`) with server tools `web_search_20260209` (`max_uses: 3`) and `web_fetch_20260209` (`max_uses: 3`). Use structured output for the result `{ placeName, address, cityCode, website, ticketUrl, reserveUrl, eventDate, confidence: "high"|"medium"|"low", evidence: string[] }`. Spike first to confirm server tools and structured output work together in one request. If they don't, use a forced client tool for the final answer instead.
- **Page reads:** web fetch runs on Anthropic's servers and only fetches URLs that appeared in the message or in search results. That keeps the rule that the API itself never fetches arbitrary URLs. Our own outbound calls stay limited to the fixed oEmbed endpoints, the geocoder and Anthropic.
- **Context:** we send the stop city's name and country, so search is biased to the right place.
- **Untrusted content:** the email is untrusted. The model has no tools that write; the output is schema-checked and sanitised (https only, no IP or localhost hosts, length limits). A URL is kept only if it appears in the tool results the model received. We never use coordinates from the model.
- **Budget:** one lookup per activity, at most 5 per message, 45 seconds per message. Web search is billed per search (about US$10 per 1,000 at the time of writing; check current pricing) on top of tokens. At this group's volume that's cents a month.
- **Settings:** `INBOX_LOOKUP=on|off`. Off, or with no API key, the basic reader keeps today's behaviour: the link only, no pin.

### Geocoder

- An interface `Geocoder.search({ text, near: {lat, lon}, countryIso }) → { lat, lon, address, osmId } | null`.
- First implementation: **Nominatim** (public OSM service). It needs no key. Its usage policy:
  - at most one request a second, enforced with a queue in the API
  - a `User-Agent` naming the app (`Trippr (github.com/brady29/Trippr)`)
  - results cached
  - no bulk jobs.

  We send only place names and city names, never member data.
- `GEOCODER=nominatim|none`. A paid provider (Geoapify, MapTiler, LocationIQ) can replace it behind the same interface if coverage or limits become a problem.
- OSM covers small places in mainland China less well. When a point isn't found, fall back to geocoding the street address, then to "not on the map yet" for a person to place.

### Places on activities, outside the inbox

- **Activity drawer:** shows link chips (Website, Google Maps, Apple Maps, Tickets, Reserve, Source). Editors get **Find links**, which runs the same lookup on an existing activity. Editors can also drag the pin on a mini map or paste a Google Maps link.
- **Bulk placing (owner):** "Place everything" runs the lookup over activities with no pin, one a second, with progress shown. It gives the seeded Asia 2027 activities pins on day one.
- **Hotels:** gain an address and use the same geocoder when created without coordinates.

## Feature 1: Map tab

**Route:** `/trips/:id/map`, a new tab in the trip navigation after Graph. It's open to viewers; private booking data never appears.

**Data:** reuse the graph export (`GET /trips/:id/graph`), which already carries coordinates, city and route membership for every node. Activities now carry real coordinates and a `placed` flag. Unplaced activities are left off the map and counted. There's no new endpoint and the ETag stays as is.

**Layers** (each with a toggle; shape is always a second channel, colours from `graph-palette.ts`):

| Layer | Marker | Notes |
|---|---|---|
| Route | Existing lines: solid trains, dashed arcs for flights, dotted roads and boats | Numbered city markers, as in the route editor |
| Activities: planned | Filled circle, colour by first tag | |
| Activities: ideas | Ring, colour by first tag, size by votes | |
| Fixed-date events | Diamond | Date shown on hover or focus |
| Hotels | Square; filled when booked, outline when shortlisted | |
| Stations and airports | Triangle (rail) and plane glyph (air) | |
| Areas worth staying in | Translucent circle with a label | |

**Controls and behaviour:**

- **Route picker.** Defaults to the current route.
- **Day filter.** From the itinerary: "Day 12 · Chongqing" shows that day's stop, planned items and travel.
- **Search** across everything on the map.
- **Clustering.** MapLibre GeoJSON clustering below zoom 10.
- **Pin details.** Clicking a pin opens a card with title, tags, votes, link chips, and editor actions: plan at stop, plan for day, move pin.
- **Synced list.** A list beside the map (bottom sheet on phones) stays in step with it. Clicking a list row flies the map to the pin.
- **"Not on the map yet: 14."** Editors get a **Find places** action that runs bulk placing for this route.

**Code:**

- Extract the map setup from `components/route-map.tsx` into a shared base used by the route editor and the Map tab.
- Load the Map tab with `next/dynamic` like today.
- Keep pins under 500 per view; clustering covers the rest.

**Accessibility:** the list is a full equivalent of the map. Pins can be reached with the keyboard and have labels, and nothing relies on colour alone.

## Feature 2: Itinerary and calendar feed

### Itinerary

**Route:** `/trips/:id/itinerary?route=<id>`, defaulting to the current route.

Each day shows:

- **Where you wake up and sleep.** The stop and its booked or chosen hotel.
- **Travel that day.** Legs with local departure and arrival times, using the stored offsets.
- **Planned activities**, ordered by start time; untimed ones at the end.
- **Fixed-date events** that fall on that day.
- **Day state:** travel day, full, light, or **free day**. Free days are highlighted and offer "Ask for ideas", which opens the assistant with the day filled in.

**Planning onto days:**

- The relationship that marks an activity planned at a stop gains optional `day` (YYYY-MM-DD), `startTime` (HH:MM, local) and `durationMin`.
- Editors drag an activity between days within its stop (dnd-kit, as in the route editor) or pick a day and time in the activity drawer.
- If the route changes so a stop's dates move, days are kept by **offset from arrival**. A day that falls outside the stop is cleared and listed under "needs a new day".

**Conflicts** (shown inline, in plain words):

- An activity overlaps a leg's departure or arrival window, with a 2-hour buffer for flights and 45 minutes for trains.
- An activity is planned on a weekday it isn't open (`when.weekdays`).
- An activity is planned outside its stop's dates.
- A fixed-date event falls on a day the route isn't in that city. This reuses the existing check.

**Time zones:**

- Add an IANA `tz` to City (seeded for all 11 cities; `Asia/Shanghai`, `Asia/Tokyo`, and so on).
- A day belongs to the stop where you sleep that night.

**API:** `GET /routes/:id/itinerary` returns `{ days: [{ date, stopId, cityCode, tz, kind, stay, legs, items, conflicts }] }`. It's computed in `packages/rules`, so the web app and the calendar feed share it and it's unit-tested without a database. `PATCH /routes/:id/plans/:activityId` sets `day`, `startTime` and `durationMin`.

### Calendar feed

The existing per-route `.ics` download stays. The feed adds a subscription that updates itself:

- **Getting the link:** "Add to calendar" on the Itinerary tab gives each member a private link: `webcal://…/cal/<token>.ics` with a copy button, plus Google Calendar and Apple Calendar buttons.
- **Token:**
  - 32 random bytes, stored only as a SHA-256 hash.
  - One per member per trip; the member can rotate it.
  - Membership is checked on every fetch, so removing someone from the trip kills their feed.
- **What's in it:**
  - The trip's current route.
  - Legs as timed events, converted to UTC from their stored offsets so every calendar shows them correctly.
  - Stays as all-day events from check-in to check-out.
  - Planned activities with a day: timed when they have a start time, all-day otherwise.
  - Each event links back to Trippr and to the activity's Maps pin.
- **Booking references:** included only when the member is an editor **and** ticks "Include booking references". Calendar providers store feed contents on their own servers, so this is off by default. Viewer feeds never include them.
- **Event IDs and caching:**
  - Stable UIDs (`leg-<id>@trippr`, `stay-<stopId>@trippr`, `act-<stopId>-<activityId>@trippr`) plus `LAST-MODIFIED`, so a change updates the event instead of duplicating it.
  - `Cache-Control: private, max-age=900`.
  - Google Calendar refreshes subscriptions on its own schedule, which can take up to a day. The UI says so.

## Feature 3: Trip assistant

### Asking

- **Opening it:** an **Ask** button in the trip header opens a side panel (a full-height sheet on phones). Suggested prompts: "What's still unbooked?", "Which days are free?", "Is there a train from Chengdu to Chongqing?", "What's near our Tokyo hotel?"
- **Model call:** `claude-opus-5-5` with adaptive thinking, streamed to the browser over SSE from `POST /trips/:id/assistant`.
  - The system prompt and a compact trip snapshot (routes, stops, dates, counts) are prompt-cached.
  - Details come through tools rather than being pasted in.
- **Tools (read):** each one calls the existing API in-process with a short-lived token for the asking user, the same pattern the inbox uses to apply changes. Role checks, private-field rules and validation therefore apply automatically: a viewer's assistant can never see a booking reference.

| Tool | Backed by |
|---|---|
| `get_route(routeId?)` | Route view (current route by default) |
| `get_itinerary(routeId?, from?, to?)` | Itinerary endpoint |
| `search_activities(cityCode?, tags?, text?, planned?)` | Library |
| `get_bookings()` | Booked tab data, filtered by role |
| `find_paths(from, to, mode?)` | Pathfinding |
| `near(lat, lon, km)` | Places on the map within a distance (new, small Cypher query) |
| `compare_routes(a, b)` | Compare |

- **Facts from the web:** `web_search_20260209` (`max_uses: 2`) for things the graph doesn't hold, such as opening hours, visa rules and ticket release dates. Answers show citations.
- **Answer format:** answers end with structured references (`stopIds`, `activityIds`, `legIds`) that render as chips. **Show on map** filters the Map tab to them, which delivers the earlier spec's "Ask the trip on the graph" stretch item.

### Suggested changes (editors)

- The assistant has one more tool, `propose_changes`, which writes nothing. It returns proposal cards: add an activity (with links, found by the Feature 4 lookup), plan an activity for a day, change a stop's nights, add a stop, add a leg idea.
- Each card shows what will change. **Apply** sends the normal API request as the editor, so version locking, checks and live updates all behave as if the editor had done it by hand. A version conflict shows "The plan changed; ask again".
- Viewers never get `propose_changes`.

### Limits and storage

- **Per-question limits:** at most 8 tool calls per question and `max_tokens` 4,000 per answer.
- **Daily limit:** 30 questions per member per day (`ASSISTANT_DAILY_LIMIT`). The owner can see usage.
- **Threads:** stored per member per trip (`(:User)-[:ASKED]->(:AssistantThread {tripId, messagesJson, updatedAt})`), private to that member. Only the last 20 turns are sent back to the model. Members can clear a thread.
- **Demo:** off for the demo account, because public visitors would spend real money. The demo shows a recorded example conversation instead.
- **Kill switch:** `ASSISTANT_ENABLED=true|false`.

## Feature 5: Portfolio polish

The README is already detailed. The gaps:

- **LICENSE.** MIT.
- **README refresh:**
  - Update the feature table (Graph, Booked, Inbox, Map, Itinerary, Assistant).
  - Add 4 screenshots and a 20-second GIF in `docs/img/`, taken from the demo trip.
  - Keep the Mermaid architecture diagram, adding Postmark, Claude and the geocoder.
  - Link this spec from the README.
- **Error tracking:** Sentry on web and API (free developer plan), with `SENTRY_DSN` and `NEXT_PUBLIC_SENTRY_DSN` as optional settings. Scrub email bodies, booking references, inbox addresses and tokens before sending. Release tagged with the commit SHA from the deploy workflow.
- **Public-repo checks:** a gitleaks secret scan in CI, Dependabot for npm and GitHub Actions, and a short `SECURITY.md` saying how to report a problem.
- **Inbox eval set:**
  - About 30 anonymised messages in `apps/api/test/fixtures/inbox-eval/`: flight, train, hotel, social captions, listicles, Google Maps links and junk. Each has its expected suggestions and links.
  - `pnpm eval:inbox` runs them against the real model and prints field-level scores. It is run by hand before changing the reader or lookup, never in CI, because it costs money. Each run costs well under a dollar.

## Data model additions

| Change | Detail |
|---|---|
| Activity properties | `lat`, `lon`, `address`, `website`, `ticketUrl`, `reserveUrl`, `mapsUrl` (only when it came from a Google Maps link; otherwise built from name and address), `placeStatus` (`unplaced`, `placed`, `check`, `manual`, `not_found`), `geoSource` (`osm`, `manual`), `placedAt`. The existing `url` stays as the **source** link |
| Hotel properties | `address`; `lat`/`lon` already exist |
| City property | `tz` (IANA zone) |
| Planned relationship properties | `day`, `startTime`, `durationMin` |
| `(:CalendarFeed {tokenHash, tripId, includePrivate, createdAt})` | `(:User)-[:HAS_FEED]->(:CalendarFeed)`; unique `tokenHash` |
| `(:AssistantThread {id, tripId, messagesJson, updatedAt})` | `(:User)-[:ASKED]->(:AssistantThread)` |
| `(:GeocodeCache {key, lat, lon, address, osmId, fetchedAt})` | Key = normalised text + country. Shared across trips |
| InboxItem | `lookup` (`pending`, `done`, `failed`, `skipped`) so the Inbox page can show "Finding the place…" and retry |

All additions go through the existing schema files for FalkorDB and Neo4j and are tested on both. Migration: add `tz` to seeded cities, set every activity to `placeStatus: "unplaced"`, and leave everything else empty.

## API changes

| Method and path | Who | Purpose |
|---|---|---|
| `POST /activities/:id/lookup` | Editor | Run link lookup for one activity |
| `PATCH /activities/:id/place` | Editor | Set or clear the pin by hand, or from a pasted Google Maps link |
| `POST /trips/:id/places/bulk` | Owner | Place every unplaced activity on a route (rate-limited, progress over live updates) |
| `GET /routes/:id/itinerary` | Viewer | Days, items and conflicts |
| `PATCH /routes/:id/plans/:activityId` | Editor | Day, start time, duration |
| `POST /trips/:id/calendar` | Member | Create or rotate my feed link; set `includePrivate` (editors only) |
| `GET /cal/:token.ics` | Token | The feed |
| `POST /trips/:id/assistant` | Member | Ask (SSE stream) |
| `GET /trips/:id/assistant` / `DELETE` | Member | My thread / clear it |

`GET /trips/:id/graph` adds place fields to activity nodes. Live updates gain `{kind: "itinerary"}` and `{kind: "places"}`.

## Settings

New, all optional, added to `.env.example` and the deploy workflow:

- `INBOX_LOOKUP` (default `on` when a key is set)
- `GEOCODER` (`nominatim`/`none`)
- `GEOCODER_USER_AGENT`
- `ASSISTANT_ENABLED`
- `ASSISTANT_DAILY_LIMIT`
- `SENTRY_DSN`
- `NEXT_PUBLIC_SENTRY_DSN`

Secrets stay in Secret Manager; there are no new secrets apart from the optional Sentry DSN, which isn't sensitive.

## Testing

- **Rules (unit):**
  - Link classification for every row of the table.
  - The distance and name sanity check.
  - Itinerary building across time zones and date-line cases.
  - Conflict rules.
  - Feed rendering (snapshot), stable UIDs, and UTC conversion.
- **API, both databases:**
  - Lookup with a fake model and a fake geocoder: links attached, unsure pins wait, URLs not in tool results are dropped.
  - The pin is never taken from model output.
  - Feed tokens: rotation, revocation on removal, and no private fields for viewers or without the opt-in.
  - The assistant with a scripted fake model: tools run as the asking user, so a viewer's `get_bookings` has no references; viewers get no `propose_changes`; Apply goes through version locking.
  - Daily limit.
- **End-to-end (Playwright, fakes on):**
  - A pasted TikTok link becomes an activity with Website and Google Maps chips and a pin on the Map tab.
  - Dragging an activity to another day updates the itinerary.
  - An assistant proposal applies and the route updates.
- **Eval set:** run by hand, as above.

## Build plan

One PR per row; CI green on FalkorDB and Neo4j before merging.

| PR | Contents | Depends on |
|---|---|---|
| A | Portfolio basics: LICENSE, README refresh (screenshots later), Sentry, gitleaks, Dependabot, `SECURITY.md` | None |
| B | Places on activities: model, geocoder with cache and queue, link chips, Find links, manual pin, bulk placing | None |
| C | Inbox link lookup: classification, Claude lookup with web search and fetch, sanity checks, `lookup` state, eval set | B |
| D | Map tab: shared map base, layers, clustering, synced list, day filter hook | B |
| E | Itinerary: City `tz`, day fields, itinerary rules and endpoint, tab, drag to day, conflicts | None |
| F | Calendar feed | E |
| G | Assistant, read-only: tools, streaming panel, citations, Show on map, limits, threads | D, E |
| H | Assistant suggested changes | G, C |
| I | Final README screenshots and GIF of the finished features | D, E, G |

PRs A, B and E can run in parallel.

## Risks

| Risk | Mitigation |
|---|---|
| OSM coverage in mainland China misses small restaurants and shops | Fall back to the street address, then to manual placing; a paid geocoder can replace it behind the same interface |
| A social caption names a place vaguely, or names the wrong one | Low-confidence results apply the idea but leave the pin as "Check the pin"; the source link is always kept |
| Prompt injection in emails or fetched pages | No write tools during lookup; output schema-checked; URLs kept only if they appear in tool results; auto-apply rules unchanged |
| Nominatim rate limits or a usage block | One request a second, cache, identifying User-Agent, no bulk jobs beyond the owner's one-off placing; `GEOCODER=none` switch |
| Assistant cost or abuse | Daily limit, token cap, off for the demo, kill switch |
| Booking references leaking into calendars | Off by default, editors only, explicit opt-in with a warning |
| Calendar apps refresh slowly | Say so in the UI; the download still works for an instant copy |
| Google Maps blocked in China | Apple Maps and Amap links for China stops |

## Decisions

Settled on Nov 19, 2026:

1. **LICENSE:** MIT.
2. **Assistant for demo visitors:** off; the demo shows a recorded example conversation.
3. **Amap links:** yes, for China stops, alongside Apple Maps. Check the URL format by hand before shipping.
4. **Pins:** placed automatically when the lookup is confident (`high`); anything less waits as "Check the pin".
5. **Claude budget:** a monthly spend limit is set in the Anthropic console.
