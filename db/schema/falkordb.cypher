// Trippr schema for FalkorDB. Idempotent: safe to re-run.
// Applied by `pnpm db:migrate` (the default dialect).
//
// FalkorDB has no CREATE CONSTRAINT in Cypher. Uniqueness is the
// GRAPH.CONSTRAINT CREATE command, which needs an exact-match (range) index
// on the property first; the migration runner creates that index and then
// the constraint for each GRAPH.CONSTRAINT line below.

GRAPH.CONSTRAINT CREATE UNIQUE NODE User PROPERTIES 1 id;
GRAPH.CONSTRAINT CREATE UNIQUE NODE Trip PROPERTIES 1 id;
GRAPH.CONSTRAINT CREATE UNIQUE NODE Route PROPERTIES 1 id;
GRAPH.CONSTRAINT CREATE UNIQUE NODE Stop PROPERTIES 1 id;
GRAPH.CONSTRAINT CREATE UNIQUE NODE City PROPERTIES 1 code;
GRAPH.CONSTRAINT CREATE UNIQUE NODE Country PROPERTIES 1 iso;
GRAPH.CONSTRAINT CREATE UNIQUE NODE Activity PROPERTIES 1 id;
GRAPH.CONSTRAINT CREATE UNIQUE NODE Tag PROPERTIES 1 name;
GRAPH.CONSTRAINT CREATE UNIQUE NODE Invite PROPERTIES 1 token;
GRAPH.CONSTRAINT CREATE UNIQUE NODE Comment PROPERTIES 1 id;
CREATE INDEX FOR (n:City) ON (n.name);
CREATE INDEX FOR (n:Activity) ON (n.title);

// Trip Graph Explorer: stations and airports share the Hub label (kind = station | airport).
GRAPH.CONSTRAINT CREATE UNIQUE NODE Hub PROPERTIES 1 hubId;
GRAPH.CONSTRAINT CREATE UNIQUE NODE Area PROPERTIES 1 id;
GRAPH.CONSTRAINT CREATE UNIQUE NODE Hotel PROPERTIES 1 id;
GRAPH.CONSTRAINT CREATE UNIQUE NODE Leg PROPERTIES 1 id;
GRAPH.CONSTRAINT CREATE UNIQUE NODE Migration PROPERTIES 1 id;
CREATE INDEX FOR (n:Area) ON (n.name);

// Trip inbox: confirmations and links sent to the trip address.
GRAPH.CONSTRAINT CREATE UNIQUE NODE InboxItem PROPERTIES 1 id;
CREATE INDEX FOR (n:Trip) ON (n.inboxToken);

// Geocoder answers, shared across trips.
GRAPH.CONSTRAINT CREATE UNIQUE NODE GeocodeCache PROPERTIES 1 key;

// Calendar feeds: one private link per member per trip, stored only as a token hash.
GRAPH.CONSTRAINT CREATE UNIQUE NODE CalendarFeed PROPERTIES 1 tokenHash;

// Trip assistant: one thread per member per trip ((:User)-[:ASKED]->(:AssistantThread)).
GRAPH.CONSTRAINT CREATE UNIQUE NODE AssistantThread PROPERTIES 1 id;

// Flight prices: one FlightPrice per provider, route, departure date and snapshot day; one run counter per day.
GRAPH.CONSTRAINT CREATE UNIQUE NODE FlightPrice PROPERTIES 1 id;
GRAPH.CONSTRAINT CREATE UNIQUE NODE FlightPriceRun PROPERTIES 1 id;
CREATE INDEX FOR (n:FlightPrice) ON (n.routeKey);

// Activity catalogue (data pipeline): curated places loaded from a bundle, with provenance.
// (:Activity)-[:FROM_SOURCE {sourceId, fetchedAt, licence}]->(:DataSource); one DataLoad per bundle loaded.
GRAPH.CONSTRAINT CREATE UNIQUE NODE DataSource PROPERTIES 1 id;
GRAPH.CONSTRAINT CREATE UNIQUE NODE DataLoad PROPERTIES 1 id;
CREATE INDEX FOR (n:Activity) ON (n.category);

// LLM enrichment (data pipeline): the Activities page filters on these; summary, duration and the rest are plain properties.
CREATE INDEX FOR (n:Activity) ON (n.bestTime);

// Stay analytics (data pipeline, Feature 5): per-city Inside Airbnb aggregates for the map layer (one StayMarket per
// covered city: city summary, neighbourhoods and H3 cells as compact JSON), the latest stay load, and open-data hotels
// as catalogue Hotel nodes ((:Hotel {catalogue: true})-[:IN]->(:Area), -[:FROM_SOURCE]->(:DataSource)).
GRAPH.CONSTRAINT CREATE UNIQUE NODE StayMarket PROPERTIES 1 id;
GRAPH.CONSTRAINT CREATE UNIQUE NODE StayLoad PROPERTIES 1 id;
