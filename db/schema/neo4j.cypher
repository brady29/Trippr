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

// Trip assistant: one thread per member per trip ((:User)-[:ASKED]->(:AssistantThread)).
CREATE CONSTRAINT assistant_thread_id IF NOT EXISTS FOR (n:AssistantThread) REQUIRE n.id IS UNIQUE;

// Flight prices: one FlightPrice per provider, route, departure date and snapshot day; one run counter per day.
CREATE CONSTRAINT flight_price_id IF NOT EXISTS FOR (n:FlightPrice) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT flight_price_run_id IF NOT EXISTS FOR (n:FlightPriceRun) REQUIRE n.id IS UNIQUE;
CREATE INDEX flight_price_route IF NOT EXISTS FOR (n:FlightPrice) ON (n.routeKey);

// Activity catalogue (data pipeline): curated places loaded from a bundle, with provenance.
// (:Activity)-[:FROM_SOURCE {sourceId, fetchedAt, licence}]->(:DataSource); one DataLoad per bundle loaded.
CREATE CONSTRAINT data_source_id IF NOT EXISTS FOR (n:DataSource) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT data_load_id IF NOT EXISTS FOR (n:DataLoad) REQUIRE n.id IS UNIQUE;
CREATE INDEX activity_category IF NOT EXISTS FOR (n:Activity) ON (n.category);

// LLM enrichment (data pipeline): the Activities page filters on these; summary, duration and the rest are plain properties.
CREATE INDEX activity_best_time IF NOT EXISTS FOR (n:Activity) ON (n.bestTime);

// Stay analytics (data pipeline, Feature 5): per-city Inside Airbnb aggregates for the map layer (one StayMarket per
// covered city: city summary, neighbourhoods and H3 cells as compact JSON), the latest stay load, and open-data hotels
// as catalogue Hotel nodes ((:Hotel {catalogue: true})-[:IN]->(:Area), -[:FROM_SOURCE]->(:DataSource)).
CREATE CONSTRAINT stay_market_id IF NOT EXISTS FOR (n:StayMarket) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT stay_load_id IF NOT EXISTS FOR (n:StayLoad) REQUIRE n.id IS UNIQUE;
