// One thing read from an inbox message (a ticket, a hotel, an activity idea, or nothing useful).
MATCH (t:Trip {id: $tripId})
CREATE (i:InboxItem {
  id: $id, messageId: $messageId, source: $source, sender: $from, senderName: $fromName, subject: $subject,
  receivedAt: $receivedAt, kind: $kind, status: $status, summary: $summary, suggestionJson: $suggestionJson,
  stopId: $stopId, stopLabel: $stopLabel, note: $note, appliedBy: null, appliedAt: null, lookup: $lookup
})
CREATE (t)-[:HAS_INBOX_ITEM]->(i)
RETURN i.id AS id
