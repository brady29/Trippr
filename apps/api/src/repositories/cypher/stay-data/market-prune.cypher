// Cities the newer bundle no longer covers.
MATCH (m:StayMarket)
WHERE NOT m.id IN $keep
DETACH DELETE m
