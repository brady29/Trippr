// The ids of the activities that match the library's filters, best first. The repository slices the page and
// loads the rows with activities/list. Everything is optional; null means "don't filter on this".
//   $scope     all | mine | catalogue   (mine: the group's own ideas and catalogue places it voted, commented on or planned)
//   $q         lower-case text to find in the title, local name or address
//   $source    a data source id, matched against the place's source ids
//   $bestTime  morning | afternoon | evening | night | any: places best then, and places good at any time
//   $indoor    true = indoor places, false = outdoor places (places the enrichment could not tell are left out)
//   $durationMax  places that take at most this many minutes (needs a duration)
//   $priceLevel   free | $ | $$ | $$$, exactly
//   $unvoted   true = only ideas the member $userId hasn't voted on (swipe to vote)
//   $sort      relevance (votes, then own ideas, then score) | score | title
MATCH (a:Activity)-[:FOR]->(:Trip {id: $tripId}), (a)-[:IN]->(c:City)
WHERE coalesce(a.hidden, false) = false
  AND ($cityCode IS NULL OR c.code = $cityCode)
  AND ($category IS NULL OR a.category = $category)
  AND ($source IS NULL OR $source IN coalesce(a.sourceIds, []))
  AND ($minScore IS NULL OR a.score >= $minScore)
  AND ($maxRank IS NULL OR a.rank <= $maxRank)
  AND ($fixedDates = false OR (a.when IS NOT NULL AND NOT a.when CONTAINS 'weekdays'))
  AND ($q IS NULL OR toLower(a.title) CONTAINS $q OR toLower(coalesce(a.nameLocal, '')) CONTAINS $q
       OR toLower(coalesce(a.address, '')) CONTAINS $q)
  AND ($scope <> 'catalogue' OR a.catalogue = true)
  AND ($bestTime IS NULL OR a.bestTime = $bestTime OR a.bestTime = 'any')
  AND ($indoor IS NULL OR a.indoor = $indoor)
  AND ($durationMax IS NULL OR a.durationMin <= $durationMax)
  AND ($priceLevel IS NULL OR a.priceLevel = $priceLevel)
OPTIONAL MATCH (me:User {id: $userId})-[mine:VOTED]->(a)
WITH a, mine
WHERE $unvoted = false OR mine IS NULL
OPTIONAL MATCH (:User)-[v:VOTED]->(a)
WITH a, sum(coalesce(v.value, 0)) AS votes, count(v) AS voters
OPTIONAL MATCH (:Stop)-[p:PLANS]->(a)
WITH a, votes, voters, count(p) AS plans
OPTIONAL MATCH (cm:Comment)-[:ON]->(a)
WITH a, votes, voters, plans, count(cm) AS comments
OPTIONAL MATCH (a)-[:TAGGED]->(tg:Tag)
WITH a, votes, collect(tg.name) AS tags, (voters + plans + comments) AS engagement
WHERE ($tag IS NULL OR $tag IN tags)
  AND ($scope <> 'mine' OR coalesce(a.catalogue, false) = false OR engagement > 0)
  AND ($includeUnlisted OR coalesce(a.listed, true) = true OR engagement > 0)
WITH a, votes, CASE WHEN a.catalogue = true THEN 1 ELSE 0 END AS fromCatalogue
WITH a, CASE WHEN $sort = 'relevance' THEN votes ELSE 0 END AS k1,
        CASE WHEN $sort = 'relevance' THEN fromCatalogue ELSE 0 END AS k2,
        CASE WHEN $sort = 'title' THEN 0 ELSE coalesce(a.score, 0) END AS k3
RETURN a.id AS id, k1, k2, k3
ORDER BY k1 DESC, k2 ASC, k3 DESC, a.title ASC, a.id ASC
