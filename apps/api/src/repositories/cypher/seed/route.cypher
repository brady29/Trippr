// A route is an ordered set of Stop nodes; each stop points at a shared City.
MATCH (t:Trip {id: $tripId})
MERGE (r:Route {id: $id})
ON CREATE SET r.name = $name, r.tags = $tags, r.isCurrent = $isCurrent, r.version = 0, r.createdAt = $now
MERGE (t)-[:HAS_ROUTE]->(r)
WITH r
UNWIND $stops AS st
MATCH (c:City {code: st.city})
MERGE (s:Stop {id: st.id})
ON CREATE SET s.order = st.order, s.nights = st.nights, s.arriveMode = st.arriveMode, s.arriveNote = st.arriveNote, s.notes = st.notes
MERGE (r)-[:HAS_STOP]->(s)
MERGE (s)-[:AT]->(c)
WITH s, st
UNWIND st.plans AS activityId
MATCH (a:Activity {id: activityId})
MERGE (s)-[:PLANS]->(a)
