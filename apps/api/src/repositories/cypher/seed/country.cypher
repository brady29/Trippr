// Reference data: refreshed on every seed run.
UNWIND $countries AS row
MERGE (k:Country {iso: row.iso})
SET k.name = row.name, k.color = row.color, k.visaRule = row.visaRule
