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
