// Catalogue places the newest bundle no longer lists, but the group voted on, commented on or planned:
// kept, marked "no longer listed" (inactive).
MATCH (a:Activity)
WHERE a.id IN $ids AND a.catalogue = true
SET a.listed = false, a.unlistedAt = $now
