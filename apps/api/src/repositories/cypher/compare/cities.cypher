// Query 3: compare two routes by the cities they visit.
MATCH (:Route {id: $a})-[:HAS_STOP]->(:Stop)-[:AT]->(ca:City)
WITH collect(DISTINCT ca) AS citiesA
MATCH (:Route {id: $b})-[:HAS_STOP]->(:Stop)-[:AT]->(cb:City)
WITH citiesA, collect(DISTINCT cb) AS citiesB
RETURN [c IN citiesA WHERE c IN citiesB | c.name] AS shared,
       [c IN citiesA WHERE NOT c IN citiesB | c.name] AS onlyA,
       [c IN citiesB WHERE NOT c IN citiesA | c.name] AS onlyB
