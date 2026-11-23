// Edits are remembered (edited) so the load job leaves a catalogue place's text alone afterwards.
MATCH (a:Activity {id: $activityId})
SET a.title = coalesce($title, a.title),
    a.url = CASE WHEN $setUrl THEN $url ELSE a.url END,
    a.when = CASE WHEN $setWhen THEN $when ELSE a.when END,
    a.costCad = CASE WHEN $setCost THEN $costCad ELSE a.costCad END,
    a.website = CASE WHEN $setWebsite THEN $website ELSE a.website END,
    a.ticketUrl = CASE WHEN $setTicketUrl THEN $ticketUrl ELSE a.ticketUrl END,
    a.reserveUrl = CASE WHEN $setReserveUrl THEN $reserveUrl ELSE a.reserveUrl END,
    a.edited = true
RETURN a.id AS id
