// Stored travel links between two cities, either direction.
MATCH (a:City {code: $from})-[l:LINK]-(b:City {code: $to})
RETURN l.mode AS mode, l.minutes AS minutes, l.costCad AS costCad, l.source AS source, l.note AS note
