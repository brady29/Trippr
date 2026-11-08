// Portable weighted search: enumerate bounded paths, optionally only over the
// given modes ("is there a train at all?"), and keep the cheapest. Fine for a
// travel network of a few dozen cities.
MATCH p = (a:City {code: $from})-[:LINK*1..6]->(b:City {code: $to})
WHERE all(e IN relationships(p) WHERE size($modes) = 0 OR e.mode IN $modes)
WITH p, reduce(total = 0, e IN relationships(p) |
       total + CASE $weight WHEN 'minutes' THEN coalesce(e.minutes, 0) WHEN 'costCad' THEN coalesce(e.costCad, 0) ELSE 1 END) AS total
RETURN [n IN nodes(p) | n.code] AS cities,
       [e IN relationships(p) | e {.mode, .minutes, .costCad, .source, .asOf}] AS legs,
       total
ORDER BY total, size(relationships(p))
LIMIT 1
