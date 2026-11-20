// Trippr schema for Neo4j 5 / AuraDB. Idempotent: safe to re-run.
// Applied by `pnpm db:migrate` with DB_DIALECT=neo4j.

CREATE CONSTRAINT user_id IF NOT EXISTS FOR (n:User) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT trip_id IF NOT EXISTS FOR (n:Trip) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT route_id IF NOT EXISTS FOR (n:Route) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT stop_id IF NOT EXISTS FOR (n:Stop) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT city_code IF NOT EXISTS FOR (n:City) REQUIRE n.code IS UNIQUE;
CREATE CONSTRAINT country_iso IF NOT EXISTS FOR (n:Country) REQUIRE n.iso IS UNIQUE;
CREATE CONSTRAINT activity_id IF NOT EXISTS FOR (n:Activity) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT tag_name IF NOT EXISTS FOR (n:Tag) REQUIRE n.name IS UNIQUE;
CREATE CONSTRAINT invite_token IF NOT EXISTS FOR (n:Invite) REQUIRE n.token IS UNIQUE;
CREATE CONSTRAINT comment_id IF NOT EXISTS FOR (n:Comment) REQUIRE n.id IS UNIQUE;
CREATE INDEX city_name IF NOT EXISTS FOR (n:City) ON (n.name);
CREATE INDEX activity_title IF NOT EXISTS FOR (n:Activity) ON (n.title);

// Trip Graph Explorer: stations and airports share the Hub label (kind = station | airport).
CREATE CONSTRAINT hub_id IF NOT EXISTS FOR (n:Hub) REQUIRE n.hubId IS UNIQUE;
CREATE CONSTRAINT area_id IF NOT EXISTS FOR (n:Area) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT hotel_id IF NOT EXISTS FOR (n:Hotel) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT leg_id IF NOT EXISTS FOR (n:Leg) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT migration_id IF NOT EXISTS FOR (n:Migration) REQUIRE n.id IS UNIQUE;
CREATE INDEX area_name IF NOT EXISTS FOR (n:Area) ON (n.name);

// Trip inbox: confirmations and links sent to the trip address.
CREATE CONSTRAINT inbox_item_id IF NOT EXISTS FOR (n:InboxItem) REQUIRE n.id IS UNIQUE;
CREATE INDEX trip_inbox_token IF NOT EXISTS FOR (n:Trip) ON (n.inboxToken);

// Geocoder answers, shared across trips.
CREATE CONSTRAINT geocode_cache_key IF NOT EXISTS FOR (n:GeocodeCache) REQUIRE n.key IS UNIQUE;

// Calendar feeds: one private link per member per trip, stored only as a token hash.
CREATE CONSTRAINT calendar_feed_token_hash IF NOT EXISTS FOR (n:CalendarFeed) REQUIRE n.tokenHash IS UNIQUE;
