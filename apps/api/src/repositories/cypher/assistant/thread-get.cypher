// One member's assistant thread on one trip.
MATCH (t:AssistantThread {id: $id})
RETURN t {.id, .tripId, .messagesJson, .updatedAt} AS thread
