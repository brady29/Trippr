// Renumber a stop's legs after an insert in the middle.
UNWIND $seqs AS row
MATCH (:Stop {id: $stopId})-[v:ARRIVES_VIA]->(:Leg {id: row.legId})
SET v.seq = row.seq
