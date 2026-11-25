// What "Suggested for this stop" needs about the trip's activities in one city, in one read and never the vector:
// who voted and how, how many plans (any route of the trip) and comments, the tags, and the fields the ranking and
// the enrichment filters read. Hidden activities are left out. Catalogue places the latest bundle dropped are
// returned with listed = false, so the service can still read their votes as signals but never suggest them.
// The votes are collected last, so every earlier grouping key is a plain value or a list of names. An activity with
// no vote gets one empty entry in `votes` (userId null), which the repository drops.
MATCH (a:Activity)-[:FOR]->(t:Trip {id: $tripId}), (a)-[:IN]->(c:City {code: $cityCode})
WHERE coalesce(a.hidden, false) = false
OPTIONAL MATCH (t)-[:HAS_ROUTE]->(:Route)-[:HAS_STOP]->(s:Stop)-[:PLANS]->(a)
WITH a, count(s) AS planCount
OPTIONAL MATCH (cm:Comment)-[:ON]->(a)
WITH a, planCount, count(cm) AS commentCount
OPTIONAL MATCH (a)-[:TAGGED]->(tg:Tag)
WITH a, planCount, commentCount, collect(tg.name) AS tags
OPTIONAL MATCH (u:User)-[v:VOTED]->(a)
WITH a, planCount, commentCount, tags, collect({userId: u.id, value: v.value}) AS votes
RETURN a.id AS id, a.title AS title, coalesce(a.catalogue, false) AS catalogue, coalesce(a.listed, true) AS listed,
       a.category AS category, a.rank AS rank, a.score AS score, a.bestTime AS bestTime, a.indoor AS indoor,
       votes, planCount, commentCount, tags
ORDER BY id
