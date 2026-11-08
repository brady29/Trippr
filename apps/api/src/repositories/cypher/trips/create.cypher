// A new trip starts with its creator as owner and one empty current route.
MATCH (u:User {id: $userId})
CREATE (t:Trip {id: $id, name: $name, startDate: $startDate, createdAt: $now})
SET t.homeCity = $homeCity
CREATE (u)-[:MEMBER_OF {role: 'owner', at: $now}]->(t)
CREATE (t)-[:HAS_ROUTE]->(:Route {id: $routeId, name: 'Main', tags: [], isCurrent: true, version: 0, createdAt: $now})
RETURN t.id AS id
