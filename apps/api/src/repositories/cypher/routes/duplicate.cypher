// Copy the source route's stops, re-linked to the same cities and activities,
// plus a DERIVED_FROM edge for lineage. One statement, so it is atomic.
MATCH (t:Trip)-[:HAS_ROUTE]->(src:Route {id: $fromRouteId})
CREATE (t)-[:HAS_ROUTE]->(r:Route {id: $id, name: $name, tags: $tags, isCurrent: false, version: 0, createdAt: $now})
CREATE (r)-[:DERIVED_FROM {at: $now}]->(src)
WITH r
UNWIND $stops AS st
MATCH (c:City {code: st.cityCode})
CREATE (r)-[:HAS_STOP]->(s:Stop {id: st.id, order: st.order, nights: st.nights, arriveMode: st.arriveMode})
SET s.arriveNote = st.arriveNote, s.notes = st.notes, s.stayCadPerNight = st.stayCadPerNight, s.arriveCostCad = st.arriveCostCad
CREATE (s)-[:AT]->(c)
WITH s, st
UNWIND st.plans AS plan
MATCH (a:Activity {id: plan.activityId})
CREATE (s)-[pl:PLANS]->(a)
SET pl.day = plan.day, pl.startTime = plan.startTime, pl.durationMin = plan.durationMin
