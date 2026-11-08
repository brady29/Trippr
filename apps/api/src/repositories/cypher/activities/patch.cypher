MATCH (a:Activity {id: $activityId})
SET a.title = coalesce($title, a.title),
    a.url = CASE WHEN $setUrl THEN $url ELSE a.url END,
    a.when = CASE WHEN $setWhen THEN $when ELSE a.when END,
    a.costCad = CASE WHEN $setCost THEN $costCad ELSE a.costCad END
RETURN a.id AS id
